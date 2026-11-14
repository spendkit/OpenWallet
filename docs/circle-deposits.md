# Circle deposits (sandbox)

Instead of polling Base for transfers to addresses we derive, a Circle developer-controlled wallet is created for each card on the fly, and Circle calls us when USDC arrives. Code: `src/adapters/deposits/CircleDeposits.ts`, route `POST /webhooks/circle` in `src/createHttpServer.ts`, wiring in `src/main.ts`, tests `test/circle.test.ts`. Reference: Circle's skills page (developers.circle.com/ai/skills), `use-developer-controlled-wallets`.

**Status: unit-tested against mocks, and checked end to end once in the sandbox** with a real 20 USDC faucet deposit on Base Sepolia (Circle wallet per card, signed webhook, ledger credit; the catch-up pass covers missed deliveries). Only that one path was exercised: ETH-SEPOLIA, a redelivery from Circle itself and a longer outage were not.

Open before production: sweeping and withdrawals are not built (see the USDC recommendation below); and a window busier than 500 inbound transfers is only partly covered by the catch-up pass (see Limits).

## Which deposit mode?

| Mode | When | Set | Credits real USDC? |
| --- | --- | --- | --- |
| Simulated | Trying the API, demos, CI | `ALLOW_SIMULATED_DEPOSITS=1` (`pnpm dev:up` sets it). The API credits a fake deposit | No |
| Derived addresses + chain watcher | Testnet USDC with no Circle account | Nothing: it is the default when Circle is not configured (`CHAIN_WATCHER=1` keeps it on alongside Circle). The service derives addresses from its HD wallet ([deposit-watcher.md](deposit-watcher.md)) | Testnet only |
| Circle wallets (this page) | Testnet now, mainnet later | `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, `CIRCLE_WALLET_SET_ID`, and a public HTTPS URL for the webhook | Yes (testnet; mainnet via the going-live steps) |

Production refuses simulated deposits (`APP_ENV=production`). Variables: [configuration.md](configuration.md).

## Setup

1. Circle Console: create a **TEST** API key, and generate and register an entity secret (32 random bytes as 64 hex characters; keep Circle's recovery file safe).
2. Environment (never in the repo): `CIRCLE_API_KEY` (`TEST_API_KEY:...`, anything else is refused), `CIRCLE_ENTITY_SECRET`, `CIRCLE_WALLET_SET_ID`.
3. `tsx scripts/circle-setup.ts wallet-set` prints a wallet set id for `CIRCLE_WALLET_SET_ID`. Keep it fixed: it is part of the wallet idempotency key.
4. Circle must reach `/webhooks/circle` over public HTTPS (a tunnel for a laptop). List the tunnel host in `WEBHOOK_ONLY_HOSTS` (comma separated) and **not** in `ALLOWED_HOSTS`: a webhook-only host answers just `/webhooks/circle` and `/healthz` (everything else is a 404), so the public tunnel never exposes the dashboard or APIs. Restart the service for it to take effect, then `tsx scripts/circle-setup.ts subscribe https://<host>/webhooks/circle`.
5. Start the service. With the key set, new cards get Circle wallets (BASE-SEPOLIA, EOA) and the chain pollers are off (`CHAIN_WATCHER=1` keeps them for older HD addresses).

## Flow

`ensureDepositAddress` → `deriveAddress(index)` → `createDepositWallet(index)` (idempotent per index, so a retry returns the same wallet) → address stored in `deposit_address` before it is shown.

Webhook: verify `X-Circle-Signature` (ECDSA SHA-256, public key by `X-Circle-Key-Id`) over the raw body, then **re-read the transaction from Circle's API** and credit only if it is `INBOUND`, `COMPLETE`, on a supported chain, a USDC token, to one of our addresses. The ledger key is `deposit:circle-<chain>:<txHash>:0`, so Circle's at-least-once redelivery credits once. Non-2xx makes Circle retry; ignored events return 200. Sub-cent dust is never credited; dust left over from a credited deposit is logged once. A notification key lookup that fails is logged with Circle's real status (the caller only sees 401), and only failed lookups count against the 20-a-minute budget.

## Limits

- Sandbox only; no sweeping, no withdrawals. Circle holds the keys, which is the custody answer for later, but treasury movement is not built.
- Only BASE-SEPOLIA wallets are created; ETH-SEPOLIA deposits are credited if the same address receives them, which is unconfirmed.
- The catch-up pass (once a minute) reads the last 2 hours, up to 10 pages of 50, newest first (`pageAfter`). A longer outage or a busier window needs a longer lookback or a manual run. Transfers to our addresses that it will not credit (wrong token, odd shape, under a cent) are logged once each.
- Address creation is serialised per card within one process and prefers the lowest `derivation_index`; two processes racing on one card could still leave an unused extra Circle wallet, which is harmless.

## Dust (sub-cent amounts)

A transfer under one cent is not credited and has no ledger entry (a ledger transaction needs whole cents). It is logged once per process as `dust <n> base units on <txHash> (not credited)`, on the webhook path and the catch-up pass alike, and reconcile no longer lists it as "ignored" every pass. Dust left over from a credited deposit is logged the same way. The record is the log line only; after a restart a transfer still inside the 2-hour lookback is logged once more. The money stays in that card's Circle wallet and is swept with the rest, so nothing is lost.

## Going live (Base mainnet)

Code is ready; the account steps are yours. Nothing changes until all of these are set: the default stays the sandbox.

In the Circle Console (`console.circle.com`):
1. Create or upgrade to a **production** Developer Services account (separate from the sandbox account; may need business verification and billing).
2. Create a **live** API key (not `TEST_API_KEY:`) with Wallets and Notifications access. Add it as `CIRCLE_API_KEY` in your secret store.
3. Generate a **new** entity secret for production (32 random bytes, 64 hex) and register it with Circle (the sandbox one is not reused). Add it as `CIRCLE_ENTITY_SECRET`. Store Circle's recovery file offline and backed up in two places: losing the secret and the file means losing the wallets.
4. Create the production wallet set (`CIRCLE_NETWORK=BASE CIRCLE_LIVE=1 tsx scripts/circle-setup.ts wallet-set`) and set `CIRCLE_WALLET_SET_ID`.

Then in the environment: `CIRCLE_NETWORK=BASE` and `CIRCLE_LIVE=1`. `circleNetwork()` refuses to start if the key and network disagree (test key on BASE, live key on BASE-SEPOLIA) or if `CIRCLE_LIVE=1` is missing for mainnet. Wallets are then created on `BASE` and only the Base mainnet USDC contract (`0x8335…2913`) is credited, under ledger label `circle-base`.

Other things that must be true first: the permanent webhook host (named tunnel or real server, in `WEBHOOK_ONLY_HOSTS`), re-subscribing with `tsx scripts/circle-setup.ts subscribe https://<host>/webhooks/circle` using the live key, deleting the old trycloudflare subscription, and the Miden production switch (the Miden client is still sandbox-only, so a mainnet credit could not yet be topped up into a real card). Do the small live test last, with tier caps set low.

## USDC in the per-card wallets (recommendation)

Facts: the Miden top-up is paid from the Miden USD wallet, not from the received USDC, so received USDC simply accumulates in the card wallets. Today's wallets are EOAs: moving USDC out needs a little ETH on Base in each wallet, which does not scale to one wallet per card. Circle's Gas Station sponsors gas for smart-contract (SCA) wallets only (verify on the current Circle docs before relying on it).

Recommendation:
1. **Do not sweep yet.** Circle custodies the keys; idle USDC in the card wallets costs nothing and risks nothing new. The sweep is only worth building once you decide how USDC becomes dollars at Miden (open todo: bank wire vs Miden stablecoin collection).
2. **Decide the wallet type before going live, because it cannot be changed per wallet afterwards.** Create production card wallets as **SCA** so gas can be sponsored, instead of EOA. Existing sandbox wallets are irrelevant.
3. When the Miden route is chosen: a scheduled **batch sweep** (daily, or when a wallet holds at least about $50) from each card wallet to one **treasury wallet** in the same wallet set, via Circle's transfer API with Gas Station. The ledger needs a matching `sweep` entry (holding stays per card; treasury is an asset account) so books and chain balances reconcile.
4. From the treasury wallet, convert to dollars the way the Miden decision dictates: Circle Mint redemption to a bank account (needs a Circle Mint account, a separate product from Developer Services) followed by a wire to Miden, or a direct stablecoin transfer if Miden accepts one.
