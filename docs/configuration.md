# Configuration

Every environment variable the service and its scripts read. Nothing loads `.env` by itself: export the variables, or run `node --env-file=.env --import tsx src/main.ts`. Copy [`.env.example`](../.env.example) to start. `pnpm dev:up` needs none of them.

Which of these you need depends on the mode:

| Mode | Set |
| --- | --- |
| Mock (default) | Nothing. Postgres comes from `DATABASE_URL`, Docker or Homebrew |
| Miden sandbox | `MIDEN_CLIENT_ID`, `MIDEN_CLIENT_SECRET`, `MIDEN_UNIQUE_KEY` (`CARD_PROVIDER=miden` is implied) |
| Circle deposits | `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, `CIRCLE_WALLET_SET_ID` and a public HTTPS URL for the webhook |
| Production | `APP_ENV=production` and the Production section below |

## Server

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Listen port |
| `HOST` | `127.0.0.1` | Listen address |
| `PUBLIC_URL` | `http://127.0.0.1:$PORT` | Base of links the service hands out |
| `ALLOWED_HOSTS` | none | Extra `Host` headers to accept (comma separated). `127.0.0.1`, `localhost` and `[::1]` on `PORT` are always accepted |
| `WEBHOOK_ONLY_HOSTS` | none | Hosts that may reach only `/webhooks/*` (for example a tunnel). Do not also list them in `ALLOWED_HOSTS` |
| `DATABASE_URL` | `postgres://localhost/agent_cards` | Postgres 16. Migrations run at start. `scripts/sandbox-up.sh` fills it in from Docker or Homebrew when unset |

## Card provider

| Variable | Default | Meaning |
| --- | --- | --- |
| `CARD_PROVIDER` | `miden` if `MIDEN_CLIENT_ID` is set, else `mock` | `mock` or `miden`. See [card providers](card-providers.md) |
| `MIDEN_BASE_URL`, `MIDEN_TOKEN_URL` | Miden sandbox hosts | Required over `https` when `APP_ENV=production` |
| `MIDEN_CLIENT_ID`, `MIDEN_CLIENT_SECRET` | none | OAuth client credentials; the secret also signs requests ([miden-api.md](miden-api.md)) |
| `MIDEN_UNIQUE_KEY` | none | Sent as the `UniqueKey` header |
| `MIDEN_WEBHOOK_HASH` | none | HMAC key for `x-signature`; used by `scripts/webhook-*.ts` |
| `CARD_VAULT_KEY` | none | 32 random bytes, base64 (`openssl rand -base64 32`). Without it card details are not captured and checkout swaps are off. Losing it loses every vaulted card |

## Deposits and chain

| Variable | Default | Meaning |
| --- | --- | --- |
| `ALLOW_SIMULATED_DEPOSITS` | `1` from `sandbox-up.sh`, else off | Lets the API credit a fake deposit (sandbox demos, `pnpm dev:keys`). Refused when `APP_ENV=production` |
| `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET` | none | Set both or neither. A `TEST_API_KEY:` key is the sandbox. See [circle-deposits.md](circle-deposits.md) |
| `CIRCLE_WALLET_SET_ID` | none | Required with the two above. `pnpm exec tsx scripts/circle-setup.ts wallet-set` makes one; keep it fixed |
| `CIRCLE_NETWORK` | `BASE-SEPOLIA` | `BASE` (mainnet) also needs `CIRCLE_LIVE=1` and a live key |
| `CIRCLE_LIVE` | off | Deliberate switch for mainnet |
| `CHAIN_WATCHER` | off when Circle is on | `1` keeps the derived-address pollers for older addresses |
| `BASE_RPC_URL` | public Base Sepolia RPC | Chain watchers and payouts |
| `ETHEREUM_SEPOLIA_RPC_URL` | public Ethereum Sepolia RPC | Ethereum Sepolia watcher |
| `DEPOSIT_WALLET_FILE` | `.sandbox-wallet.json` | HD deposit wallet seed file (git-ignored). Back it up: it holds the keys |
| `PAYOUT_ADDRESS_DELAY_S` | `600` | Waiting period before a new payout address can be paid |

## Checkout swap

Agents paying hosted Stripe checkouts with the vaulted card. Off unless `SWAP_ENABLED=1`; needs `CARD_VAULT_KEY`. See [checkout-swap.md](checkout-swap.md).

| Variable | Default | Meaning |
| --- | --- | --- |
| `SWAP_ENABLED` | off | `1` to turn on |
| `SWAP_MAX_CENTS` | `1000` | Hard cap per swap |
| `SWAP_ALLOWED_HOSTS` | `checkout.stripe.com,buy.stripe.com` | Exact https hosts that may be paid |
| `SWAP_RECEIPT_EMAIL` | none | Email used on the checkout form |
| `ANTHROPIC_API_KEY` | none | Lets a model map unfamiliar forms. Without it only clear labels are filled |
| `SWAP_AI_FILL`, `SWAP_AI_MODEL` | on if the key is set | `SWAP_AI_FILL=0` disables; the model is configurable |
| `SWAP_STRIPE_TEST_CARD` | off | Sandbox only: Stripe test-mode links get the Stripe test card. Refused in production |
| `SWAP_TEST_HOSTS`, `SWAP_INSECURE_HOSTS` | none | Sandbox only: exact hosts of local test shops (the second allows plain http) |
| `SWAP_OPEN_HOSTS` | off | Public https checkouts outside the allow-list, paid with a one-time card only |

## Production and alerts

| Variable | Default | Meaning |
| --- | --- | --- |
| `APP_ENV` | unset (sandbox) | `production` is the only way to use a non-sandbox Miden host. It requires `CARD_PROVIDER=miden` and https Miden URLs, and refuses to start with `ALLOW_SIMULATED_DEPOSITS=1` or `SWAP_STRIPE_TEST_CARD=1` |
| `MIDEN_WALLET_MIN_USD` | `100` in production, off in sandbox | Low-balance alert level, in dollars |
| `ALERT_WEBHOOK_URL` | none | Slack-compatible webhook that gets `{ text }` for low balance, Circle webhook 5xx, reconcile errors and stuck top-ups |
| `STUCK_FUNDING_MINUTES` | `15` | Minutes a top-up may sit in `reserved` before it alerts |

See [production gaps](production-gaps.md) and the [runbook](runbook.md) before running with real money.

## Clients and examples

| Variable | Used by | Meaning |
| --- | --- | --- |
| `AGENT_CARDS_URL` | examples, `scripts/dev-quickstart.ts`, `src/startMcpStdio.ts` | Service URL (default `http://127.0.0.1:8787`). The SDK itself takes `baseUrl` in its constructor |
| `AGENT_CARDS_SECRET_KEY` | `examples/shop`, your merchant server | `mk_...` merchant key. Server side only |
| `AGENT_CARDS_AGENT_TOKEN` | examples | `ak_...` agent token |
| `AGENT_CARDS_TOKEN` | `src/startMcpStdio.ts` | `ak_...` agent token for stdio MCP |

`pnpm dev:keys` writes these to `.env.sandbox-keys`.
