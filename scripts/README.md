# Scripts

Run from the repo root. Most take their settings from the environment ([docs/configuration.md](../docs/configuration.md)). Nothing here prints secrets.

## Everyday (no accounts needed)

| Script | What it does |
| --- | --- |
| `sandbox-up.sh`, `sandbox-down.sh` | Start and stop the service in the background (`pnpm dev:up`, `pnpm dev:down`) |
| `dev-quickstart.ts` | Sandbox keys in `.env.sandbox-keys`, then a paid test checkout (`pnpm dev:keys`) |
| `swap-rehearsal.ts` | Checkout-swap form filler in headless Chromium with a test card; no database, no accounts |

## Miden sandbox (needs `MIDEN_*`; sandbox money only)

| Script | What it does |
| --- | --- |
| `sandbox-smoke.ts` | Read-only: gets a token, lists balances. First thing to run if you get a 401/403 |
| `sandbox-demo.ts`, `e2e.ts` | End-to-end of the running service as a user and an agent would drive it |
| `sandbox-readonly.ts`, `sandbox-check.ts` | Read-only probes of the issuer API |
| `sandbox-kyc-individual.ts`, `sandbox-kyb.ts`, `sandbox-issue.ts`, `sandbox-topup.ts`, `sandbox-lite.ts`, `sandbox-corporate.ts`, `sandbox-dupref.ts` | Spikes against single issuer endpoints, saving state in `.sandbox-state.json` (git-ignored). Useful as API examples; not part of normal use |
| `card-capture-check.ts` | Issues one card and proves card-detail capture works on a real response |
| `swap-sandbox-e2e.ts` | Checkout swap end to end with a Miden sandbox card and local Chromium |
| `webhook-receiver.ts`, `webhook-subscribe.ts` | Capture issuer webhooks locally; point the issuer's webhooks at a URL |

## Circle and real money (read the docs first)

| Script | What it does |
| --- | --- |
| `circle-setup.ts` | One-off: create a wallet set, subscribe the webhook ([docs/circle-deposits.md](../docs/circle-deposits.md)) |
| `circle-reconcile.ts` | Manual catch-up of missed Circle deposits with a longer lookback |
| `swap-live-test.ts` | **Spends real money** (one live payment). Only per [docs/live-usdc-test.md](../docs/live-usdc-test.md) and [docs/checkout-swap.md](../docs/checkout-swap.md) |
