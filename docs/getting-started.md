# Getting started (developers)

For developers who want to **accept payments from agents** (the checkout SDK) or **connect an agent** to an Agent Card wallet. About ten minutes to a first paid checkout. Everything here runs in the sandbox: no real money moves.

## What you need

- Node 20+ and pnpm (`pnpm install` in the repo root).
- Postgres 16. The start script finds one for you: your own (`DATABASE_URL`), else Docker (`docker compose`), else Homebrew `postgresql@16`.
- **No card-issuer account.** With no `MIDEN_*` set the service uses the built-in mock card provider (in memory, KYC approved at once, Visa test number). To use the Miden sandbox instead, export `MIDEN_CLIENT_ID`, `MIDEN_CLIENT_SECRET` and `MIDEN_UNIQUE_KEY` (see [card providers](card-providers.md)).
- If you only need to try the SDK against a fake server, skip all of this: `examples/shop` has a test (`shop.test.ts`) that runs against an in-memory stand-in.

## 1. Start the service

```sh
pnpm install
pnpm dev:up                  # Postgres + the service at http://127.0.0.1:8787 (PORT=... to change)
curl -s http://127.0.0.1:8787/healthz
```

Stop it with `pnpm dev:down`; the log is `.run/server.log`.

## 2. Get sandbox keys

```sh
node --import tsx scripts/dev-quickstart.ts
```

This creates, in about a minute:

| Key | Prefix | What it is |
| --- | --- | --- |
| `AGENT_CARDS_SECRET_KEY` | `mk_` | A merchant secret key. Server side only; creates checkouts |
| `AGENT_CARDS_AGENT_TOKEN` | `ak_` | A funded test agent ($20 budget, $10 per payment, $15 per day). It stands in for a shopper's agent |
| `AGENT_CARDS_URL` | | The service URL |

They are written to `.env.sandbox-keys` (mode 600, git-ignored; nothing is printed). The script then has the agent pay a $1.00 checkout through the SDK, so you know the whole path works before you write code. It reuses earlier keys that still work; `--fresh` makes new ones, `--no-pay` skips the test payment, `--url` points at another server.

It moves a few dollars of sandbox money (mock, or Miden if configured) and uses a dummy identity for Card KYC. The simulated deposit needs `ALLOW_SIMULATED_DEPOSITS=1`, which `pnpm dev:up` sets.

Where each key comes from if you want to do it by hand: `mk_` from `POST /merchant/v1/signup` (or `AgentCardsCheckout.signup`), `ak_` from the owner dashboard at http://127.0.0.1:8787 (create an agent and give it a budget) or `POST /api/me/agents`. Both are shown once; only a hash is stored. Rotate with `POST /merchant/v1/key` (merchant) or `POST /api/me/token` (owner).

## 3. Take your first agent payment

The SDK lives in `sdk/checkout` and is not published to npm yet (`"private": true`). Import it by path from this repo, as `examples/shop` does:

```ts
import { AgentCardsAgent, AgentCardsCheckout } from "./sdk/checkout/src/index.ts";

const opts = { baseUrl: process.env.AGENT_CARDS_URL! };
const merchant = new AgentCardsCheckout({ ...opts, secretKey: process.env.AGENT_CARDS_SECRET_KEY! });

const c = await merchant.createCheckout({ amountCents: 500, description: "Test order", idempotencyKey: "order-1" });
console.log(c.checkoutUrl);                       // hand this to an agent

// Stand-in for the agent (a real one uses the MCP tool pay_checkout):
const agent = new AgentCardsAgent({ ...opts, token: process.env.AGENT_CARDS_AGENT_TOKEN! });
await agent.payCheckout(c.checkoutId, { maxAmountCents: 500 });

const done = await merchant.waitForPayment(c.checkoutId);
if (done.status === "paid") console.log("fulfil the order");
```

Run it: `node --env-file=.env.sandbox-keys --import tsx first-payment.ts`.

Rules to build around (details in the [SDK README](../sdk/checkout/README.md)):

- **Fulfil only when `status === "paid"`** from `retrieveCheckout` / `waitForPayment`. `processing` means wait; `open` after a declined attempt means the agent can retry.
- **Always send an `idempotencyKey`** on `createCheckout` (your order id works). A retry then returns the same checkout.
- **Price on your server.** The agent should pass `maxAmountCents` so a checkout whose price changed is refused without charging.
- **The secret key stays on your server.** The SDK refuses to send a key over plain `http` to anything but localhost.
- Amounts are US cents everywhere.

## 4. See a complete merchant

`examples/shop` is a small store (cart, server-priced checkout, order page, polling, cancel):

```sh
cd examples/shop
node --env-file=../../.env.sandbox-keys --import tsx server.ts     # http://127.0.0.1:4100
```

With `AGENT_CARDS_AGENT_TOKEN` set, its order page has a **Pay as demo agent** button. See [its README](../examples/shop/README.md) for the flow, file by file.

Building a product where your *users* each get a card and agents? The [developer demos](../examples/developer/README.md) cover that path (users, hosted connect page, limits, privacy mode, webhooks).

## 5. Connect a real agent

An agent needs only its `ak_` token. Over MCP it gets `get_wallet`, `pay`, `list_transactions`, `get_checkout` and `pay_checkout`:

```sh
# Claude Code
source .env.sandbox-keys   # or export the token yourself
claude mcp add --transport http agent-cards "$AGENT_CARDS_URL/mcp" --header "Authorization: Bearer $AGENT_CARDS_AGENT_TOKEN"
```

Then tell it: "pay the checkout at <checkoutUrl>". To watch an agent use MCP from code, see [`agent-mcp.ts`](../examples/developer/agent-mcp.ts). Other clients (stdio, plain REST) are in the [sandbox flow doc](sandbox-flow.md).

## Troubleshooting

| You see | Usually means |
| --- | --- |
| `cannot reach http://127.0.0.1:8787` | The service is not running: `pnpm dev:up`; check `.run/server.log` |
| `sandbox-up.sh`: `No Postgres found` | Start Docker, install `postgresql@16`, or export `DATABASE_URL` |
| 401/403 from Miden in the service log (Miden mode only) | Credentials wrong, or this machine's IP is not whitelisted in the Miden dashboard (`scripts/sandbox-smoke.ts` checks it) |
| `simulated deposit refused` | The service was started without `ALLOW_SIMULATED_DEPOSITS=1` |
| `401` from `/merchant/v1/*` or `/agent/v1/*` | A wrong, rotated or revoked key. `dev-quickstart.ts --fresh` makes new ones |
| `refusing to send a secret over plain http` | Your `baseUrl` is not localhost and not `https` |
| Payment `declined`, reason mentions per-transaction or daily limit | The agent's limits did what they are for; raise them on the dashboard, or use a smaller checkout |
| Payment `declined`, balance too low | Give the agent more budget (dashboard, or `POST /api/me/agents/<id>/fund`) |
| `409` on `cancelCheckout` | The checkout is already paid or processing |
| Checkout stays `processing` | The card network's answer is late; it settles in the background. A checkout flagged for review needs a person (README, "Ops: clearing a checkout held for review") |
| `409` on `requestPayout` | Over your available balance, no payout address set, or the new address is still in its waiting period |

## Limits to know about

Sandbox only. Payments are charged through Miden's purchase simulator, payouts are testnet USDC, there are no webhooks yet (poll), and no refund API. The list of what blocks production is in the top-level README under "Open items".
