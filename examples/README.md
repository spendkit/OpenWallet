# Examples

All examples run against the local service (`pnpm dev:up`, then `pnpm dev:keys` for keys in `.env.sandbox-keys`). They work with the default mock card provider unless a row says otherwise. Sandbox only.

| Example | What it shows | Run |
| --- | --- | --- |
| [`hello/`](hello/pay.ts) | The smallest loop: merchant creates a checkout, agent pays, merchant sees `paid` (about 20 lines) | `node --env-file=.env.sandbox-keys --import tsx examples/hello/pay.ts` |
| [`shop/`](shop/README.md) | A small store: cart, server-side pricing, order page, polling, cancel | see its README |
| [`developer/`](developer/README.md) | A product where your users get cards for their agents: onboarding, connect page, limits, privacy mode, MCP, signed webhooks | see its README |
| [`n8n/`](n8n/README.md) | n8n workflows where an agent pays over REST or MCP. The Stripe-link workflows need a Stripe test key and the checkout swap switched on ([docs/checkout-swap.md](../docs/checkout-swap.md)) | import a `*.workflow.json` |

New here? Start with [docs/getting-started.md](../docs/getting-started.md).
