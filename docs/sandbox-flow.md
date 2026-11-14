# Sandbox flow: KYC, handover to the agent, and the agent paying

Status: documents the code as it stands on 2026-10-19 (`src/lib/interactors/CardholderInteractor.ts`, `src/adapters/onboarding/onboarding.ts`, `src/lib/services/AgentWallets.ts`). Parts of this are still being built; where something is a placeholder or unverified it is marked **OPEN**. The service is **sandbox-only**: `src/main.ts` refuses to start unless `MIDEN_BASE_URL` contains `sandbox`.

## The model in one paragraph

A person (the *owner*) signs up, passes Miden Card KYC, and gets **one real Visa card** under their own Miden customer. They get a Base USDC deposit address that is tied to that card. USDC sent to that address is credited to our ledger and then moved onto the card with a Miden top-up. The owner carves **agent wallets** (ledger sub-balances with their own spend policy) out of the card balance and gives each agent a token. The agent pays through MCP or REST. The agent never does KYC and never sees card details.

Why one card per person and not one per agent: Miden caps a customer at 3 cards (sandbox), an AI agent cannot be a KYC subject, and retail cards cannot be issued under a KYB business customer (`docs/miden-api.md`, "Sandbox write verification").

```
owner ──signup──► app_user
  │
  ├─POST /api/me/kyc──► Miden kyc-submit ──(poll)──► Approved ──► issue card ──► app_card + deposit address
  │
  ├─USDC on Base Sepolia──► watcher ──► ledger holding:<card> ──► fundPending ──► Miden top-up ──► card:<card>
  │
  ├─create agent (token ak_…) ──► fund agent: card:<card> ──► agent:<card>:<agent>
  │
agent ──MCP /mcp or REST /agent/v1──► pay ──► policy + sub-balance check ──► Miden simulated authorization
```

## Running it

```
export MIDEN_CLIENT_ID=… MIDEN_CLIENT_SECRET=… MIDEN_UNIQUE_KEY=…     # only for the Miden provider; the mock needs none
export DATABASE_URL=postgres://localhost/agent_cards                  # default if unset
node --import tsx src/main.ts
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `MIDEN_CLIENT_ID`, `MIDEN_CLIENT_SECRET`, `MIDEN_UNIQUE_KEY` | required | Miden credentials. Never print or commit them. |
| `MIDEN_BASE_URL` | Miden sandbox | Must contain `sandbox` or the service throws at boot. |
| `MIDEN_TOKEN_URL` | Miden sandbox identity server | |
| `DATABASE_URL` | `postgres://localhost/agent_cards` | Migrations run at boot (`migrate(pool)`, `src/db/migrate.ts`). |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | Localhost only by design. |
| `ALLOWED_HOSTS` | none | Extra `Host` header values accepted (see DNS-rebinding guard below). |
| `BASE_RPC_URL` | `https://base-sepolia-rpc.publicnode.com` | See [deposit-watcher.md](deposit-watcher.md). |
| `DEPOSIT_WALLET_FILE` | `.sandbox-wallet.json` | See [sandbox-wallets.md](sandbox-wallets.md). |

On boot `main.ts` also: restores agent state from Postgres (`CardholderInteractor.restore()`), starts the chain watcher, and starts a 5-second background loop that finishes pending KYCs (`refresh`) and funds cards (`fundPending`).

## HTTP surface

| Path | Auth | Purpose |
| --- | --- | --- |
| `GET /`, `/docs`, `/app` | none | Landing page, documentation, owner dashboard + developer section (static files in `src/presentation/web/`). |
| `GET /healthz` | none | `{ ok: true }`. |
| `POST /api/signup` | none | Body `{ email }` → `201 { userId, token }`. Token starts `uk_`, shown once. |
| `GET /api/me` | `uk_` | Overview (KYC status, card, balances, deposit address, agents). |
| `POST /api/me/kyc` | `uk_` | Submit individual Card KYC. |
| `POST /api/me/refresh` | `uk_` | Re-check KYC, issue the card if approved. |
| `POST /api/me/simulate-deposit` | `uk_` | Sandbox only: credit a fake deposit, `{ amountCents }`, max $1,000. |
| `POST /api/me/simulate-chain-deposit` | `uk_` | Sandbox only: credit a fake chain deposit by address, `{ id: "sim_<your 0x deposit address>_USDC_<dollars>[_<nonce>]" }`, max $1,000. The id is the idempotency key; add a nonce to repeat the same amount. |
| `POST /api/me/agents` | `uk_` | Create an agent. Returns the `ak_` token once. |
| `POST /api/me/agents/{id}/fund` \| `reclaim` \| `revoke` \| `limits` | `uk_` | Manage an agent. |
| `GET /agent/v1/wallet`, `GET /agent/v1/transactions`, `POST /agent/v1/pay` | `ak_` | Agent REST API. |
| `POST /mcp` | `ak_` | Agent MCP (streamable HTTP, stateless). |

Every request must carry an allowed `Host` header (`127.0.0.1:<port>`, `localhost:<port>`, plus `ALLOWED_HOSTS`) or gets 421, so a web page on another site cannot reach the service through DNS rebinding. Bodies over 2 MB get 413. Errors are JSON `{ error }`; unexpected failures are logged server-side and returned as a bare `internal error`.

## Stage 1: signup and KYC

1. **Signup** (`CardholderInteractor.signup`): email is lower-cased and validated; a `uk_…` token is generated, and only its SHA-256 is stored. Duplicate email → 409. There is no password; the token *is* the credential (the dashboard keeps it in `localStorage`).
2. **Submit KYC** (`submitKyc`, `POST /api/me/kyc`). Required fields: `firstName`, `lastName`, `dateOfBirth` (`YYYY-MM-DD`), `idType` (`PASSPORT`, `NATIONAL_ID`, `DRIVERS_LICENSE`, `VOTERS_CARD`; upper-cased for you), `idNumber`, `phone`, `email`, `idFrontImage` (PNG/JPEG data URI, ≤ 1.5 MB of text), and `address{address1, city, state, zipcode, country}`.
   - Sent to Miden `POST /api/v1/cards/kyc-submit` as `customerType: "Individual"`.
   - **Identity data is never stored or logged by us.** We keep only `kyc_reference` and `kyc_status` on `app_user`.
   - Each attempt uses a fresh `clientReference` (`kyc-<userId>-<random>`), so a resubmission after a rejection is a new Miden request. Already `Approved` or `Initiated`/`Pending` → 409.
   - Success needs `isSuccessful: true` and `responseCode` `000` or `00` (a 200 alone is not success). Otherwise 422 with Miden's message.
3. **Status** (`refresh` → `CardLifecycle.kycStatus`): polls `GET /api/v1/cards/kyc/client-reference/{ref}` (webhooks are not used; see `docs/miden-api.md` for why). The background loop polls every 5 s for any user with a KYC in review. Statuses seen: `Initiated`, `Pending`, `Approved`, `Rejected`. In the sandbox, dummy data is approved instantly. Use distinct `idNumber`/phone/email per dummy user: Miden de-duplicates customers by identity and returns the same `customerId` for a repeat.
4. **Card issuance** (`doRefresh`): once `Approved`, `CardService.issue` calls `POST /api/v2/cards/issue` with the user's `customerId` + `kycToken`, `initialBalance` of $1 (Miden's minimum), and `clientReference: card-<userId>`. That reference is stable, and the `Reference` header is derived from it, so a retried issuance within 24 h cannot create a second card. `app_card` has a `UNIQUE(user_id)` and the insert is `ON CONFLICT DO NOTHING`. Concurrent refreshes for one user share a single in-flight promise. Then `ensureDepositAddress` derives the user's deposit address.
   - `secureCardDetails` (encrypted PAN/CVV) is deliberately never read, stored or returned.
   - The `kycToken` is a credential; it is passed to Miden and not persisted or logged.

### Tiers (the limits on the owner's card)

`src/lib/services/tiers.ts`: `quick` and `full`. New users are `quick`. Limits cap the card's per-transaction and daily amounts and the **lifetime amount that may be loaded onto the card**.

| Tier | Per transaction | Per day | Lifetime funded |
| --- | --- | --- | --- |
| quick | $50 | $100 | $500 |
| full | $1,000 | $5,000 | unlimited |

**OPEN: these are placeholder numbers**; thresholds are not set (`DEFAULT_TIERS` says so). **OPEN: nothing upgrades a user from quick to full yet**; `app_user.tier` defaults to `quick` and no endpoint changes it. Money past the lifetime cap stays in the holding account until an upgrade.

## Stage 2: funding the card (summary)

Deposits and the holding → card movement are covered in [deposit-watcher.md](deposit-watcher.md). The one thing to know here: the owner's card balance is *real Miden card balance* (`midenCardBalanceDollars` on the overview) mirrored by the ledger account `card:<cardId>`, and agents can only be funded from that ledger balance.

## Stage 3: handover to the agent

Owner side, all on `uk_` token:

1. **Create** (`POST /api/me/agents`, `createAgent`): `{ name, perTransactionCents, dailyCents, allowedMccs? }`. The requested policy is **clamped to the owner's card limits** by `capPolicy`; an agent never gets more room than its owner. `allowedMccs` is a list or comma-separated string of 4-digit codes; omit it to allow any merchant category. Returns `{ agentId, name, policy, token }`. The `ak_…` token is shown **once**; only its SHA-256 is stored. The dashboard shows it once with copy-paste snippets.
2. **Fund** (`/fund`, `{ amountCents, key? }`): ledger transfer `card:<card>` → `agent:<card>:<agent>`. Fails 409 if the card's unallocated balance is short. Passing `key` makes a retry safe (the same key never allocates twice). Revoked agents cannot be funded.
3. **Reclaim** (`/reclaim`, `{ amountCents? }`): unspent agent balance back to the card; omitted amount means all of it.
4. **Limits** (`/limits`): change per-transaction, daily or MCP list; re-clamped to the card. Today's spend still counts against a new daily limit.
5. **Revoke** (`/revoke`): sets `revoked_at` (the token stops working immediately) and reclaims the whole balance.

Hand the agent two things: the token, and where to connect.

## Stage 4: the agent transacts

Two equivalent connections; both end in `CardholderInteractor.pay`.

### A. MCP over HTTP (preferred)

`POST http://127.0.0.1:8787/mcp` with `Authorization: Bearer ak_…`. Stateless streamable HTTP with JSON responses; a fresh MCP server is built per request, bound to the token's agent. Example client config:

```json
{ "mcpServers": { "agent-cards": { "type": "http", "url": "http://127.0.0.1:8787/mcp", "headers": { "Authorization": "Bearer ak_…" } } } }
```

For Claude Code: `claude mcp add --transport http agent-cards http://127.0.0.1:8787/mcp --header "Authorization: Bearer ak_…"` (the dashboard prints this with the token filled in).

### B. MCP over stdio (agents that launch local tool processes)

`src/startMcpStdio.ts` is a bridge to the REST API:

```
AGENT_CARDS_URL=http://127.0.0.1:8787 AGENT_CARDS_TOKEN=ak_… node --import tsx src/startMcpStdio.ts
```

Exits with an error if `AGENT_CARDS_TOKEN` is unset.

### C. Plain REST

| Call | Body / query | Returns |
| --- | --- | --- |
| `GET /agent/v1/wallet` | | `{ agentId, name, currency: "USD", balanceCents, limits{perTransactionCents, dailyCents, allowedMccs}, spentTodayCents, remainingTodayCents }` |
| `GET /agent/v1/transactions?limit=20` | `limit` 1 to 100 | newest-first array of spend records |
| `POST /agent/v1/pay` | `{ amountCents, merchant, mcc?, idempotencyKey? }` | spend record |

### MCP tools

| Tool | Input | Notes |
| --- | --- | --- |
| `get_wallet` | none | Read-only. Amounts in **cents**. |
| `pay` | `amount_usd` (positive, ≤ 2 decimals), `merchant` (1 to 80 chars), `mcc?` (4 digits), `idempotency_key?` (≤ 100) | Note the unit difference: MCP takes **dollars**, REST takes **cents**. Responses from both are in cents. |
| `list_transactions` | `limit?` 1 to 100 | Read-only. |

The server's MCP `instructions` tell the agent to check `get_wallet` first and to use a fresh idempotency key per purchase.

### What `pay` does (`CardholderInteractor.pay` / `doPay`)

1. Validate amount (positive integer cents), merchant (≤ 80), `mcc` (4 digits if present).
2. Idempotency: the key is scoped to (card, agent). A repeat of the same key with the same amount/merchant/mcc returns the original result without charging again; the same key with a different payment → 409. No key supplied → a random one is generated (so retries without a key are *not* deduplicated). Concurrent attempts on one key are serialised in-process; `UNIQUE (card_id, agent_id, idempotency_key)` backs that up.
3. Insert an `app_spend` row as `processing`.
4. **Our checks** (`AgentWallets.spend` → `evaluate`): per-transaction limit, daily limit (UTC day, approved spends only), MCC allow-list, then the agent's sub-balance in the ledger. Failure → status `declined` with the reason (`per-transaction limit exceeded`, `daily limit exceeded`, `merchant category not allowed`, `insufficient agent balance`); nothing is charged. Note an allow-list rejects a payment that **omits** `mcc`.
5. Debit the agent's ledger balance (`agent:…` → `external:merchant`), then charge the card: in the sandbox that is Miden's mock authorization, `POST /api/v1/mock/authorization`.
6. Card approves → `approved`. Card refuses or errors → our ledger debit is **reversed** and the status is `voided` with `card declined: …`.

Statuses: `processing` (transient), `approved`, `declined` (our limits), `voided` (the card network said no; nothing was charged).

**Crash safety:** `restore()` at boot finds any `processing` spend (we cannot know if the card was charged), reverses the ledger entry, marks it `voided` with "interrupted by a restart; check the card statement", and rebuilds today's per-agent totals from approved spends of the last 2 days.

## Known limits and OPEN items (read before demoing)

- **Agent limits are enforced by us only for spends that go through `pay`.** Miden sees one card. If someone uses the card details directly, our per-agent limits and sub-balances are bypassed. Closing this needs customer-managed authorization (Miden calls us per transaction) or limits pushed to Miden. Not decided (README open item 3).
- **Live charging is disabled.** Outside the sandbox `doPay` throws; in the sandbox the "merchant" is Miden's simulator, so no real purchase happens. Agents get no card number.
- **`CardService.authorize()`** and `TieredCardIssuer` keep spend/funded totals in memory (README item 6); the app service does not rely on them: agent totals are rebuilt from `app_spend` at boot, and lifetime funding is computed from `app_funding`.
- **Tier amounts are placeholders and there is no upgrade path** (above).
- **Webhooks are not used**; KYC and balances are polled. Subscribing is blocked on Miden's side (`docs/miden-api.md`).
- **Auth is bearer tokens, no rotation or expiry.** Revoking an agent is permanent; there is no "re-issue token". A lost `uk_` token means a lost account (no recovery flow).
- **Single process.** The in-process locks (`paying`, `issuing`, `funding`) assume one server instance.

## Verifying it end to end

`scripts/sandbox-demo.ts` drives the whole flow exactly as an owner and an agent would (signup → dummy KYC → card → deposit → top-up → agent → MCP payments, limits, idempotency, revocation). It **moves sandbox money** and prints no tokens:

```
node --import tsx scripts/sandbox-demo.ts [http://127.0.0.1:8787]
```

Unit tests (`pnpm test`; the Postgres suites run only with `DATABASE_URL` set) cover the ledger, onboarding, tiers, lifecycle, wallets and the watcher.
