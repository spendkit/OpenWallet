# agent-cards docs

Written 2026-10-19 from the code in the working tree (Mira is still building parts of it; each doc marks what is OPEN).

| Doc | Covers |
| --- | --- |
| [architecture.md](architecture.md) | **Start here if you are working on agent-cards itself.** Components, the ledger, key flows, data model, security model, failure handling, known limits |
| [getting-started.md](getting-started.md) | **Start here if you are integrating.** Sandbox keys in one command, first agent payment, sample shop, connecting an agent, troubleshooting |
| [Checkout SDK](../sdk/checkout/README.md) | `@agent-cards/checkout` reference: merchant and agent clients, statuses, payouts, the HTTP API table |
| [Developer demos](../examples/developer/README.md) | Runnable scripts for the developer API: onboarding and the hosted connect page, agent limits, privacy (one-time card) mode, an MCP agent, a signed-webhook receiver with tests |
| [Sample shop](../examples/shop/README.md) | A complete merchant built on the SDK, file by file |
| [sandbox-flow.md](sandbox-flow.md) | Signup, Card KYC, card issuance, tiers, handing a wallet to an agent, the agent paying over MCP (HTTP or stdio) or REST, HTTP surface, known limits |
| [checkout-swap.md](checkout-swap.md) | An agent paying a third-party hosted checkout with the owner's vaulted card: flow, statuses, busy 409, amount+time matching, config, proving it |
| [deposit-watcher.md](deposit-watcher.md) | The Base USDC watcher: config, tick loop, units and dust, idempotency, deposit addresses, holding-to-card funding, open items |
| [sandbox-wallets.md](sandbox-wallets.md) | Our own HD deposit wallet for the demo, address allocation, step-by-step demo setup, what is deliberately missing |
| [finance-data.md](finance-data.md) | Ledger design, accounts and kinds, Postgres tables, write ordering, what we do and do not store |
| [checkout-payouts.md](checkout-payouts.md) | Checkout, settlement, merchant payouts, and what blocks mainnet |
| [ops.md](ops.md) | Runbooks: a checkout or payout held for review |
| [production-gaps.md](production-gaps.md) | Not production-ready items and the numbered open-items list |
| [card-providers.md](card-providers.md) | The card-issuing ports, the mock and Miden providers, adding another |
| [miden-api.md](miden-api.md) | What the Miden Workspace API docs say and what the sandbox confirmed |

The top-level [README](../README.md) has a short overview, configuration and layout.
