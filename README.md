# OpenWallet

Virtual cards for AI agents, funded with stablecoins. Card issuing is pluggable: a built-in **mock** provider runs with no external accounts, and the [Miden Workspace API](https://docs.miden.co/getting-started) (the card-issuance REST API, not the Miden blockchain) is the first real provider. See [card providers](docs/card-providers.md).

**Status:** works end to end with the mock provider and in the Miden sandbox. **Sandbox only, not production-ready:** see [production gaps](docs/production-gaps.md).

## Start here

- **Integrating a merchant or agent?** [docs/getting-started.md](docs/getting-started.md): `pnpm dev:up`, then `pnpm dev:keys` for sandbox keys and a paid test checkout. Then the [checkout SDK](sdk/checkout/README.md) and the [sample shop](examples/shop/README.md).
- **Building a product where your users get cards for their agents?** [docs/developers.md](docs/developers.md) and the [developer demos](examples/developer/README.md).
- **Working on agent-cards itself?** Start with the [architecture](docs/architecture.md), then [docs/](docs/README.md).

## How it fits together

[![agent-cards architecture](docs/architecture.png)](docs/architecture.svg)

1. A user signs up and passes card KYC. The card provider issues one card.
2. USDC sent to the user's Base deposit address is credited to our ledger, then moved onto the card.
3. The owner gives agents budgets and limits. Agents pay over MCP or REST.
4. Merchants take agent payments through checkouts and are paid out in USDC.

Full structure, flows and design decisions: [docs/architecture.md](docs/architecture.md). Details: [sandbox-flow.md](docs/sandbox-flow.md), [deposit-watcher.md](docs/deposit-watcher.md), [checkout-payouts.md](docs/checkout-payouts.md).

## Quickstart (no accounts needed)

You need Node 20+, pnpm, and either Docker or a Postgres 16 you can reach. With no `MIDEN_*` set, the built-in mock card provider is used.

```
pnpm install
pnpm dev:up              # Postgres (Docker, Homebrew, or your DATABASE_URL) + the service on http://127.0.0.1:8787
pnpm dev:keys            # sandbox keys written to .env.sandbox-keys, then a paid $1.00 test checkout
open http://127.0.0.1:8787   # owner dashboard
pnpm dev:down            # stop the service
```

To use the Miden sandbox instead of the mock, export `MIDEN_CLIENT_ID`, `MIDEN_CLIENT_SECRET` and `MIDEN_UNIQUE_KEY` before `pnpm dev:up`, then `node --import tsx scripts/sandbox-demo.ts` runs an end-to-end check (moves sandbox money). Test USDC: faucet.circle.com, Base Sepolia.

| Mode | Needs | Good for |
| --- | --- | --- |
| Mock (default) | Node, pnpm, Postgres | Trying the API, SDK, MCP and dashboard; building your integration |
| Miden sandbox | Miden sandbox credentials and an allow-listed IP | Real issuer behaviour with test money |
| Circle deposits | Circle API keys ([docs/circle-deposits.md](docs/circle-deposits.md)) | Crediting real testnet USDC deposits |

Connect an agent (the dashboard shows these with the token filled in):

```
claude mcp add --transport http agent-cards http://127.0.0.1:8787/mcp --header "Authorization: Bearer ak_..."   # MCP over HTTP
AGENT_CARDS_URL=http://127.0.0.1:8787 AGENT_CARDS_TOKEN=ak_... node --import tsx src/startMcpStdio.ts          # MCP over stdio
curl -s http://127.0.0.1:8787/agent/v1/pay -H "Authorization: Bearer ak_..." -H "content-type: application/json" \
  -d '{"amountCents":500,"merchant":"Example API","mcc":"5734","idempotencyKey":"order-1"}'                    # REST
```

## Library use

```ts
import { CardService, MidenClient, MidenWalletFunding, configFromEnv, evaluate } from "./src/index.js";

const miden = new MidenClient(configFromEnv());
const cards = new CardService(miden, new MidenWalletFunding(miden));

const card = await cards.issue("agent-42", { perTransactionCents: 5_000, dailyCents: 20_000, allowedMccs: ["5734"] });
await cards.topUp(card, 10_000, "USDC", "topup-agent-42-0001"); // idempotency key: a retry never double-funds
evaluate(card.policy, { amountCents: 2_500, mcc: "5734", spentTodayCents: 0 }); // { ok: true } or { ok: false, reason }
```

Amounts are USD cents throughout.

## Configuration

Every variable, with defaults and which mode needs it: [docs/configuration.md](docs/configuration.md). Copy [`.env.example`](.env.example) to start. The Miden variables below are only for `CARD_PROVIDER=miden`.

`configFromEnv()` throws if a required variable is missing. Nothing loads `.env` automatically: export them or use `node --env-file=.env`.

| Variable | Meaning |
| --- | --- |
| `MIDEN_BASE_URL` | API base URL (required) |
| `MIDEN_TOKEN_URL` | OAuth client-credentials token endpoint (required) |
| `MIDEN_CLIENT_ID`, `MIDEN_CLIENT_SECRET` | Credentials; the secret is also used in every signature (required) |
| `MIDEN_UNIQUE_KEY` | Sent as the `UniqueKey` header (required) |
| `MIDEN_WEBHOOK_HASH` | HMAC key for `x-signature`; only for `scripts/webhook-*.ts` |

Request signing is documented in [docs/miden-api.md](docs/miden-api.md). Smoke check: `node --env-file=.env --import tsx scripts/sandbox-smoke.ts` (read-only; a 401/403 with correct keys usually means this machine's IP is not whitelisted in the Miden dashboard).

## Layout

The code is layered: `routes/ -> controllers/ -> lib/interactors/ -> lib/services/ / adapters/ -> db/repositories/, lib/clients/`. Details in [docs/architecture.md](docs/architecture.md#51-source-layout).

| Path | What it is |
| --- | --- |
| `src/main.ts`, `src/bootstrap.ts`, `src/createApp.ts` | Entry point; env -> clients, repositories, adapters (`AppParams`); `AppParams` -> interactors |
| `src/routes/`, `src/controllers/`, `src/lib/middleware/` | HTTP: route tables, thin controllers, guards and auth |
| `src/lib/interactors/` | Use cases: cardholders (signup, KYC, agents, pay), checkouts, payouts, hosted-checkout swaps, developers |
| `src/lib/services/` | `Ledger`, `AgentWallets`, `SpendPolicy` and `evaluate()`, tiers |
| `src/lib/clients/` | `MidenClient` (token and signed requests), `CircleClient` |
| `src/adapters/` | `CardService` (`issue`, `topUp`), `MidenWalletFunding`, deposit watchers and Circle webhooks, payout rail, checkout fillers, card vault |
| `src/db/` | Repositories (ledger store, chain cursor, deposit addresses) and SQL migrations |
| `src/errors.ts` | `AgentCardsError` and its factories |
| `sdk/checkout/` | `@agent-cards/checkout`, the merchant and agent SDK |
| `test/` | `node:test` tests |

## Dev

Node 20+ and pnpm. `docker compose up -d` starts a local Postgres (see `docker-compose.yml`); the Postgres test suites skip without `DATABASE_URL`.

```
pnpm install
pnpm test        # tsx --test test/*.test.ts
pnpm typecheck
pnpm build
```

## More

| Doc | Covers |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | **Architecture:** components, ledger, key flows, data model, security, failure handling |
| [docs/README.md](docs/README.md) | Index of all docs |
| [docs/ops.md](docs/ops.md) | Runbooks: checkout or payout held for review |
| [docs/checkout-payouts.md](docs/checkout-payouts.md) | Checkout, settlement, payouts, what blocks mainnet |
| [docs/production-gaps.md](docs/production-gaps.md) | Not production-ready items and the open-items list |

## Contributing, security and licence

- [CONTRIBUTING.md](CONTRIBUTING.md) and the [code of conduct](CODE_OF_CONDUCT.md).
- Report vulnerabilities privately: [SECURITY.md](SECURITY.md).
- Licensed under the [Apache License 2.0](LICENSE).
