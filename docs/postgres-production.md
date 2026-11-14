# Production Postgres: migrations, backup and restore (plan)

Status: **plan, not yet executed.** Todo tmvta9havc. Nothing here has been run against a production database. The ledger tests have not yet been run against any Postgres either (todo tmvta9havb); do that first, because this plan assumes the migrations apply cleanly on a real server.

## What lives in the database

| Group | Tables | Loss means |
| --- | --- | --- |
| Ledger (source of truth for money) | `ledger_tx`, `ledger_posting`, `ledger_balance` (001) | Money records gone. Not recoverable from Circle or Miden alone. |
| Chain | `deposit_address`, `chain_cursor` (002) | Card-to-address mapping gone: deposits to Circle wallets can no longer be matched to a card. |
| App | `app_user/card/agent/spend/funding` (003), checkout, payout, swap, developer, one-time-card tables (004-011) | Cards, spends, in-flight funding and payouts lose their state. |
| Vault | `card_vault`, `card_vault_audit` (008) | Sealed card details. Useless without `CARD_VAULT_KEY`, which is **not** in the database. |

The ledger is append-only (update, delete and truncate are blocked by triggers), so the real risks are loss of the server and a bad migration, not a stray UPDATE.

## Migrations

`src/db/migrate.ts` runs every `src/db/migrations/*.sql` not yet in `ledger_migrations`, each in its own transaction, under an advisory lock, on every boot. That is fine for dev. For production:

1. **Do not let the app migrate itself on boot.** Run migrations as a separate step before the new version starts (a release step that calls `migrate()` with a migrator-role URL), so a failing migration blocks the release and not the first request.
2. **Two roles.** `migrator` owns the schema; the app role has only SELECT/INSERT/UPDATE (and DELETE only on tables that need it). It must not be able to DROP the ledger triggers or TRUNCATE. The triggers are a guard against bugs, not against a role that owns the table.
3. **Before each production migration:** take a fresh backup (below), run the migration against a restored copy of the latest production backup, and run `SELECT * FROM ledger_check_balances();` before and after. It must return zero rows both times.
4. **Forward-only.** There are no down migrations. A bad migration is fixed by a new numbered file, or by restoring the pre-migration backup if it ran in a transaction and committed something wrong. Never edit an applied file.
5. **Locking:** the migration files are plain CREATE and ALTER. Before any future `ALTER TABLE ledger_*` or index on a large table, check for `ACCESS EXCLUSIVE` locks and use `CREATE INDEX CONCURRENTLY` in its own non-transactional step (the migrator wraps files in a transaction, so that needs a small change).
6. **First production run:** empty database, apply 001-011, run the Postgres test suite against it in a throwaway schema only (the tests create and drop their own `t_...` schemas; never point `DATABASE_URL` for tests at the production database).

## Backup

Decide as a team. Recommended default, assuming a managed Postgres (Neon, Supabase, RDS or similar):

- **Point-in-time recovery (PITR)** switched on, retention at least 7 days (14 is better). This is what covers "someone ran a bad migration at 14:03".
- **Daily logical backup** (`pg_dump -Fc`) copied to storage in a *different* account or provider, encrypted, retained 30 days then monthly for a year. Protects against losing the provider account, which PITR does not.
- **Before every migration:** an on-demand dump labelled with the release.
- **If self-hosted instead:** `pg_basebackup` plus WAL archiving (pgBackRest or WAL-G) to object storage. More work; only choose it if a managed service is ruled out.

Keys that must be backed up *separately from the database*, or the database backup is worthless for the affected data:

- `CARD_VAULT_KEY` (and any previous `key_id`s, since rows carry a `key_id`). Without it every `card_vault` row is unreadable.
- `CIRCLE_ENTITY_SECRET` and Circle's recovery file (todo tmwc0fdun3): losing it means losing the wallets.
- Miden credentials and `MIDEN_WEBHOOK_HASH`: replaceable, but note where they live.

Put these in a password manager or KMS with two people able to reach them. They must never share a bucket with the database dumps.

## Restore

A backup that has never been restored is a hope, not a backup. Before go-live:

1. **Restore drill:** restore the latest dump into a scratch database, run `migrate()` (it should apply nothing), then check:
   - `SELECT * FROM ledger_check_balances();` returns no rows.
   - Row counts for `ledger_tx` and `ledger_posting` match the source at backup time.
   - Boot the app against it (with Miden and Circle disabled or in sandbox) and open one card's page.
2. **Time it** and write the number down (the recovery time objective).
3. **Repeat quarterly**, and after any change of provider.

Real incident order of operations:

1. Stop the app and the Circle webhook consumer (return non-2xx or take the webhook host down; Circle retries, so deliveries are not lost within its retry window).
2. Restore to the chosen point.
3. Run `ledger_check_balances()`.
4. **Reconcile against the outside world.** The database can be older than reality. Anything between the restore point and the incident is missing locally but may already have happened at Circle or Miden:
   - Circle deposits: run the catch-up reconcile (`docs/circle-deposits.md`, the 2-hour lookback; extend it manually to cover the gap). Credits are idempotent on `deposit:circle-<chain>:<txHash>:0`, so replays are safe.
   - Miden top-ups and spends: any `app_funding` row missing locally but present at Miden needs a manual ledger entry. List Miden's transactions for the gap and compare references.
   - Payouts: check `app_payout` rows in `sending` against the chain before releasing anything (see `docs/ops.md`).
5. Only then start the app again.

## Open decisions

1. Which Postgres host (managed vs self-hosted).
2. Retention and where the off-account copy lives.
3. Who holds the vault key and Circle entity secret backups.
4. Is losing up to a few minutes of transactions acceptable (daily dump only), or do we need PITR (recommended, since money is involved).
