// The smallest end-to-end example: a merchant creates a checkout, an agent pays it, the merchant sees "paid".
// Run (service up, keys made by `pnpm dev:keys`), from the repo root:
//   node --env-file=.env.sandbox-keys --import tsx examples/hello/pay.ts
import { AgentCardsAgent, AgentCardsCheckout } from "../../sdk/checkout/src/index.ts";

const baseUrl = process.env.AGENT_CARDS_URL!;
const merchant = new AgentCardsCheckout({ baseUrl, secretKey: process.env.AGENT_CARDS_SECRET_KEY! });
const agent = new AgentCardsAgent({ baseUrl, token: process.env.AGENT_CARDS_AGENT_TOKEN! });

const checkout = await merchant.createCheckout({
  amountCents: 500,
  description: "Hello order",
  idempotencyKey: `hello-${Date.now()}`, // your order id in a real shop: a retry returns the same checkout
});
console.log("checkout", checkout.checkoutId, checkout.checkoutUrl);

await agent.payCheckout(checkout.checkoutId, { maxAmountCents: 500 }); // the agent refuses if the price changed

const done = await merchant.waitForPayment(checkout.checkoutId);
console.log(done.status === "paid" ? "paid: fulfil the order" : `not paid: ${done.status}`);
