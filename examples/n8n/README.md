# n8n: an agent pays with its Agent Card

Five n8n workflows that let an agent pay with its Agent Card against the sandbox service (`pnpm dev:up`, port 8787): three pay an Agent Cards checkout (`cs_...` from `/merchant/v1/checkouts`), one pays a Stripe checkout link.

| File | What it does | Needs |
| --- | --- | --- |
| `agent-pays-checkout.workflow.json` | Merchant creates a checkout (`mk_`), agent checks its wallet and limits, pays it over `/agent/v1` (`ak_`), merchant confirms `paid`. Cancels the checkout if the agent can't afford it. | the two keys |
| `agent-pays-over-mcp.workflow.json` | Same, but the agent calls `get_wallet` and `pay_checkout` on the `/mcp` server (n8n's MCP Client node), as an LLM agent would. | the two keys |
| `agent-pays-stripe-link.workflow.json` | Paste a Stripe Checkout or Payment Link and its exact total into **Stripe link**; the agent calls `pay_hosted_checkout` on `/mcp`, the service opens the page, checks the total and pays with the owner's card (the agent never sees it). Re-running on the same link returns the first result and never pays twice. | the agent key, hosted checkouts switched on (below) |
| `agent-pays-stripe-demo.workflow.json` | **The demo.** One click: n8n creates a Stripe test checkout link itself, the agent pays it over `/mcp`, then n8n asks Stripe whether the session is `paid` and shows `demoPassed`. No link to paste. | the agent key, a Stripe test key, hosted checkouts + test-card mode (below) |
| `ai-agent-pays-over-mcp.workflow.json` | Chat with an n8n AI Agent (Claude) that has the Agent Card MCP tools (`get_wallet`, `get_checkout`, `pay_checkout`, `pay_hosted_checkout`, `get_hosted_checkout_payment`, `list_transactions`) and pays a `cs_...` checkout or a Stripe link you give it. | the two keys and an Anthropic API key |

The REST, MCP and Stripe-link workflows poll while a payment is `processing` (the card network answered late; the service settles it in the background, usually within a minute) and only report `PAID` once the merchant sees `paid`.

## Credentials

Create two **Header Auth** credentials in n8n (name `Authorization`, value `Bearer <key>`), using the keys `scripts/dev-quickstart.ts` writes to `.env.sandbox-keys`:

- `Agent Cards merchant (mk_)`: `AGENT_CARDS_SECRET_KEY`
- `Agent Cards agent (ak_)`: `AGENT_CARDS_AGENT_TOKEN`

The agent's per-payment, daily and merchant-category limits apply to every payment n8n makes, whatever the workflow says.

## Running n8n locally

n8n 2.x needs Node 24. `npm install n8n` in a folder on an internal disk (it is about 2,300 packages), then `N8N_USER_FOLDER=./data npx n8n start` and open http://localhost:5678. Import a file with **Workflows → Import from file**, or `n8n import:workflow --input=<file>`.

## Stripe checkout links (hosted checkouts)

Off by default. Start the service with `SWAP_ENABLED=1` and `CARD_VAULT_KEY` set (see `docs/checkout-swap.md`); the cap is $10 a payment and only `checkout.stripe.com` and `buy.stripe.com` are allowed.

To try it with Stripe **test mode**, also set `SWAP_STRIPE_TEST_CARD=1`: test links (`cs_test_...`, `buy.stripe.com/test_...`) are then paid with Stripe's public 4242 test card instead of the vaulted card, which a test page would refuse. The agent is still debited in the ledger (no card is charged, so that debit is not a card spend) and its limits still apply; live links are never affected. The service refuses this setting unless it is on the Miden sandbox. Make a test link with the sandbox key:

```sh
curl -s https://api.stripe.com/v1/checkout/sessions -u "$STRIPE_SANDBOX_SECRET_KEY:" -d mode=payment \
  -d "line_items[0][price_data][currency]=usd" -d "line_items[0][price_data][unit_amount]=100" \
  -d "line_items[0][price_data][product_data][name]=Test item" -d "line_items[0][quantity]=1" \
  -d success_url=https://example.com/thanks -d "managed_payments[enabled]=false"
```

and paste its `url` into the workflow with `amountUsd` 1. Tested on 2026-10-29: the run returned `PAID`, and Stripe's API showed the session `complete / paid`.

## The demo (Stripe checkout link)


Reproduce it from a clone (sandbox only, no real money):

```sh
# 1. service with hosted checkouts and Stripe test-card mode (needs CARD_VAULT_KEY, see docs/checkout-swap.md)
SWAP_ENABLED=1 SWAP_STRIPE_TEST_CARD=1 pnpm dev:up
# 2. a funded test agent; writes AGENT_CARDS_AGENT_TOKEN to .env.sandbox-keys
node --import tsx scripts/dev-quickstart.ts --fresh
# 3. n8n 2.x on Node 24 running at :5678, then import credentials + workflow (keys come from the environment, never printed)
set -a; . ./.env.sandbox-keys; set +a      # STRIPE_SANDBOX_SECRET_KEY must be a sk_test_ key in your shell
examples/n8n/demo/setup.sh
# 4. run it: open the workflow in n8n and press Execute workflow, or headless:
examples/n8n/demo/run.sh                   # prints: agent card result: PAID ... stripe says: paid / complete | demoPassed: True
# 5. (optional) re-record the video; N8N_EMAIL/N8N_PASSWORD are an n8n owner, a fresh instance gets one created
N8N_EMAIL=you@example.com N8N_PASSWORD=... node examples/n8n/demo/record.mjs docs/media
```

Notes: `setup.sh` refuses anything but a Stripe test key. Set `N8N_BIN` if `n8n` is not on your PATH. Each run creates a new $1 test link and pays it once (re-running the same link would not pay twice). If Miden calls fail with `Invalid Source`, this machine's public IP is not on the Miden whitelist (`docs/demo-guide.md` section 0). `record.mjs` needs `playwright-core` and Google Chrome.
