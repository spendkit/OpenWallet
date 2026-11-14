# Contributing

Thanks for helping. Bug reports, fixes, docs and new adapters are all welcome.

## Before you start

- For anything larger than a small fix, open an issue first so we can agree on the approach.
- Security problems go through [SECURITY.md](SECURITY.md), never a public issue.
- Read [docs/architecture.md](docs/architecture.md) for how the code is layered.

## Setup

Node 20+ and pnpm.

```
pnpm install
docker compose up -d      # Postgres on localhost:5432 (optional; the Postgres test suites skip without it)
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/agent_cards
pnpm typecheck
pnpm test
```

Running the service needs no accounts: `pnpm dev:up` uses the mock card provider. See [docs/getting-started.md](docs/getting-started.md); Miden-specific code needs Miden sandbox credentials.

## Pull requests

- Keep a pull request to one change, with tests for behaviour you add or fix.
- `pnpm typecheck` and `pnpm test` must pass; CI runs both.
- Money is integer cents; never use floats for amounts.
- Never commit secrets, `.env` files, mnemonics, real card numbers or personal data, including in tests and fixtures.
- Never log tokens, card details or keys.

## Licence

By contributing you agree that your contribution is licensed under the [Apache License 2.0](LICENSE).
