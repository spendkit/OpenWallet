# @agent-cards/checkout

Let AI agents pay you with their Agent Card. You set the price; the agent pays from the wallet its owner funded, inside the limits its owner set. No card details ever reach the agent or you.

**Sandbox only.** The agent's card is charged through Miden's sandbox purchase simulator, and no money is paid out to merchants yet (see "Not yet" below).

## Quickstart

1. Start the service (`pnpm dev:up` in the repo root) and run `pnpm dev:keys`. It writes a merchant key (`mk_…`) and a funded test agent token (`ak_…`) to `.env.sandbox-keys` and pays a $1 test checkout.
2. The package is not published to npm yet; import it by path: `import { AgentCardsCheckout } from "./sdk/checkout/src/index.ts"`.
3. Copy the snippet under "Merchant" below, or run the [sample shop](../../examples/shop/README.md).

Full walkthrough and troubleshooting: [docs/getting-started.md](../../docs/getting-started.md).

## How it works

```
your server ──createCheckout──► agent-cards ◄──pay_checkout── agent (MCP or REST)
     ▲                              │
     └──── retrieveCheckout / waitForPayment: status "paid" ──┘
```

1. Your server creates a checkout with your secret key. You get a `checkoutId` (`cs_…`) and a `checkoutUrl` (`…/pay/cs_…`).
2. You hand either one to the agent: put it on the page, return it from your API, or say it in a chat.
3. The agent calls `pay_checkout` (MCP) or `POST /agent/v1/checkouts/<id>/pay`. Its owner's per-payment, daily and merchant-category limits and its balance all apply.
4. You fulfil the order once `retrieveCheckout` (or `waitForPayment`) returns `status: "paid"`.

A checkout is paid at most once. If a payment is declined (limits, balance, or the card network), the checkout stays `open`, and the agent can try again later.

| Status | Meaning |
| --- | --- |
| `open` | Waiting for an agent to pay |
| `processing` | An agent's payment is under way (or the card network's answer is late, in which case it settles in the background). Do not fulfil yet |
| `paid` | Paid. Fulfil the order |
| `canceled` | You canceled it |
| `expired` | Nobody paid in time (default 30 minutes) |

## Merchant (server side)

```ts
import { AgentCardsCheckout, checkoutButton, checkoutMetaTag } from "@agent-cards/checkout";

// Once: create an account. The secret key is shown once; keep it server side.
const { secretKey } = await AgentCardsCheckout.signup({ baseUrl: "http://127.0.0.1:8787" }, { name: "Acme API", email: "billing@acme.example", mcc: "5734" });

const checkout = new AgentCardsCheckout({ baseUrl: "http://127.0.0.1:8787", secretKey: process.env.AGENT_CARDS_SECRET_KEY! });

const c = await checkout.createCheckout({
  amountCents: 1299,
  description: "Pro plan, 1 month",
  reference: "order_8812",          // your order id, echoed back
  idempotencyKey: "order_8812",     // a retry returns the same checkout
  metadata: { plan: "pro" },        // yours only, never shown to agents
});

// On your page (server-rendered, no script needed):
html.head += checkoutMetaTag(c);
html.body += checkoutButton(c);     // "Pay $12.99 with Agent Card"

// Or hand c.checkoutId / c.checkoutUrl straight to the agent.

const done = await checkout.waitForPayment(c.checkoutId, { timeoutMs: 120_000 });
if (done.status === "paid") fulfil(done.reference);
```

Also: `retrieveCheckout(id)`, `listCheckouts({ limit })`, `cancelCheckout(id)` (open only), `me()`, `rotateKey()`.

### Getting paid

Agent Cards is the merchant of record: each paid checkout is credited to your balance with us, and you are paid out from it. Neither you nor the agent ever sees card details.

Payouts are **USDC on Base Sepolia** (testnet) for now; bank transfers will follow.

```ts
await checkout.setPayoutAddress("0xYourWallet…");   // once; a new address waits before it can be paid
const { availableCents, pendingPayoutCents } = await checkout.balance();
const payout = await checkout.requestPayout({ amountCents: availableCents, idempotencyKey: "payout-2026-10" });
// payout.status: "requested" -> "sending" (payout.txHash) -> "sent", or "failed" (the money returns to your balance)
await checkout.listPayouts();
```

A payout is reserved from your balance the moment you ask, so it can never be paid twice or exceed what you are owed (a 409 if it would). It goes to the address you had when you asked: changing the address later does not redirect it. A new address can be paid only after a waiting period (`me().payoutAddressUsableFrom`), so that a stolen secret key cannot send your money elsewhere at once.

The SDK refuses to send a key over plain `http` to anything but localhost.

## Agent

With the agent-cards MCP server connected, the agent has two more tools:

- `get_checkout { checkout_id }`: merchant, description, price and status.
- `pay_checkout { checkout_id }`: pays at the merchant's price. Calling it again returns the first result.

Agents without MCP can use the agent client:

```ts
import { AgentCardsAgent } from "@agent-cards/checkout";
const agent = new AgentCardsAgent({ baseUrl: "http://127.0.0.1:8787", token: process.env.AGENT_CARDS_TOKEN! });
const c = await agent.getCheckout("http://127.0.0.1:8787/pay/cs_…"); // an id or the link
const { payment, checkout } = await agent.payCheckout(c.checkoutId);
```

## HTTP API

| Method and path | Auth | |
| --- | --- | --- |
| `POST /merchant/v1/signup` `{name, email, mcc?}` | none | `{merchantId, name, secretKey}` |
| `GET /merchant/v1/me` | `mk_` | |
| `POST /merchant/v1/key` | `mk_` | new secret key; the old one stops working |
| `POST /merchant/v1/checkouts` `{amountCents, description, reference?, mcc?, expiresInSeconds?, metadata?, idempotencyKey?}` | `mk_` | 201, checkout |
| `GET /merchant/v1/checkouts[?limit=]` | `mk_` | newest first |
| `GET /merchant/v1/checkouts/<id>` | `mk_` | |
| `POST /merchant/v1/checkouts/<id>/cancel` | `mk_` | open only, else 409 |
| `POST /merchant/v1/payout-address` `{address}` | `mk_` | profile with `payoutAddressUsableFrom` |
| `GET /merchant/v1/balance` | `mk_` | `{availableCents, pendingPayoutCents, currency}` |
| `POST /merchant/v1/payouts` `{amountCents, idempotencyKey?}` | `mk_` | 201, payout; 409 if over the available balance, with no address, or during an address change's wait |
| `GET /merchant/v1/payouts[?limit=]` | `mk_` | newest first |
| `GET /agent/v1/checkouts/<id>` | `ak_` | public view |
| `POST /agent/v1/checkouts/<id>/pay` `{}` | `ak_` | `{checkout, payment}` |
| `GET /pay/<id>` | none | human- and agent-readable page |
| `GET /v1/checkouts/<id>` | none | public view as JSON |

Every POST must be `content-type: application/json`. Amounts are US cents.

## Not yet

- **Bank payouts and mainnet USDC.** Testnet USDC only for now.
- **Webhooks.** Poll with `retrieveCheckout` / `waitForPayment` for now.
- **Refunds.** The ledger can take a refund back out of your balance, but there is no refund API yet (the card side of a refund is not built).
