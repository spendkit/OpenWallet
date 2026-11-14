# Developer-layer demos

Runnable scripts for the [developer API](../../docs/developers.md): onboarding, the hosted connect page, agent limits, privacy (one-time card) mode, MCP and signed webhooks. Sandbox only.

## Setup

```sh
pnpm dev:up      # service at http://127.0.0.1:8787 (mock card provider unless MIDEN_* is set; see docs/getting-started.md)
```

`AGENT_CARDS_URL` overrides the URL. The first demo signs up a developer and saves the keys it makes to `examples/developer/.env.developer-demo` (mode 600, git-ignored, never printed). The others read it.

## The demos

Run from the repo root.

| Demo | Shows | Moves sandbox money |
| --- | --- | --- |
| `node --import tsx examples/developer/01-onboard.ts` | Sign up, create a user (idempotent on your `externalId`), mint a `/connect` session, create an agent with limits, fund it, read its wallet | yes, ~$25 deposit |
| `node --env-file=examples/developer/.env.developer-demo --import tsx examples/developer/02-limits.ts` | Each refusal (per-payment, category, above-tier), your server changing limits, idempotent retry, reclaim, revoke | under $2 |
| `node --import tsx examples/developer/03-privacy.ts` | Privacy mode: a fresh one-time card per payment, and the 3-card Miden cap | yes |
| `node --env-file=examples/developer/.env.developer-demo --import tsx examples/developer/agent-mcp.ts` | An agent over MCP (`/mcp`, `ak_` token): list tools, `get_wallet`, `pay` | $0.50 |
| `WEBHOOK_SECRET=whsec_... node --import tsx examples/developer/webhook-receiver.ts` | A receiver: signature on the raw body, dedupe on event id, one handler per event type | no |
| `node --import tsx examples/developer/record-journey.ts` | Records the whole journey as a shareable video (about 2½ minutes, captioned): developer setup, hosted KYC, webhooks, funding, the user changing limits, an agent paying a shop over MCP, a payment over the limit declined, the user pausing the agent. Writes `examples/developer/recordings/agent-cards-journey.mp4` (git-ignored). Needs ffmpeg for the .mp4 | yes, $50 deposit, $21 spent |
| `node --import tsx --test examples/developer/webhook-verify.test.ts` | Offline tests of the signature check against the service's own signer: tamper, wrong secret, replay, malformed headers | no |

`02-limits.ts` and `agent-mcp.ts` need `01-onboard.ts` first (and `02-limits.ts` revokes that demo agent at the end, so run `01` again before `agent-mcp.ts`).

## Sandbox shortcuts

Real users do KYC and deposit through the hosted `/connect` page. A script has no browser, so `lib.ts` does what that page does with a **dummy identity**, using the user's own short-lived session (`kycAsUser`, `simulatedDeposit`). Deposits need `ALLOW_SIMULATED_DEPOSITS=1` (`sandbox-up.sh` sets it). Never copy those two helpers into a real integration.

## Status

Run against the Miden sandbox on 2026-10-21: demos 1, 2 and 4 pass; the webhook receiver verified and logged a live `spend.settled` event (delivered on the first attempt); demo 3 approves two payments and voids the third with Miden's "Maximum Number of Cards Per customer Limit 3 Exceeded", as described in `docs/developers.md`. The signature tests pass offline, and the full repo suite (332 tests) passes.
