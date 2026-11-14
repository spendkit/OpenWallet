# Small live test: real USDC on Base into one card (plan and checklist)

Status: **plan only. No real money has been spent and none should be until the project owner says go.**

Goal: prove the whole chain once with a few real dollars: USDC on Base mainnet to a Circle wallet, ledger credit, Miden top-up, card spend.

## Blockers (this test cannot start until these are done)

- [ ] tmwc0fdun0: Circle LIVE API key, new entity secret and wallet set, wallets on BASE (mainnet). Today the code only accepts `TEST_API_KEY` and creates BASE-SEPOLIA wallets.
- [ ] tmwc0fdun1: permanent public HTTPS webhook host, listed in `WEBHOOK_ONLY_HOSTS` only, webhook re-subscribed with the live key.
- [ ] tmwc0fdun3: live entity secret and recovery file stored safely **before** any wallet holds money.
- [ ] tmvta9hav0: decision on how USDC becomes dollars in the Miden USD wallet. Top-ups are paid from the pre-funded Miden wallet, not from the USDC, so for this test the USDC just sits in Circle.
- [ ] tmvta9hav7 and tmvta9hav8: production Miden credentials, wallet pre-funded with at least the test amount plus margin.
- [ ] tmvta9hav9: simulated deposits off (see check 3 below).
- [ ] tmvta9havb: Postgres tests pass (the live test should run on Postgres, not in-memory).

## Money limits

- Test amount: **$5 USDC total**, sent as one transfer. Hard ceiling $10 without asking again.
- Set the card tier caps low first: quick tier today is per-transaction $50, daily $100, lifetime funded $500 (`DEFAULT_TIERS` in `src/lib/services/tiers.ts`). For the test run, override to per-transaction $2, daily $3, lifetime funded $10, so a bug cannot move more than that.
- Use a throwaway test user and one card. Do not use real card details anywhere.
- Spend test: one purchase of about $1-2 at a real merchant that accepts the card.

## Checklist

### A. Before sending anything

1. [ ] Project owner gives written go-ahead with the amount and the sending wallet.
2. [ ] Production Postgres up, migrations applied, `ledger_check_balances()` returns no rows.
3. [ ] `POST simulate-deposit` and `simulate-chain-deposit` return 403 on the production host.
4. [ ] `GET /healthz` on the public webhook host works, and every other path on it is 404.
5. [ ] Webhook subscription lists only the permanent host; the trycloudflare one is deleted.
6. [ ] Create the test user and card. Record the card id and the Circle deposit address shown on the dashboard.
7. [ ] Dashboard shows "Base mainnet USDC only" and the wrong-network warning.
8. [ ] Check the address on a Base block explorer: it is a Base address owned by our Circle wallet set (compare against Circle's console).
9. [ ] Miden wallet balance recorded. Ledger balances recorded (screenshot or query).

### B. Send

1. [ ] Send **$1 first** as a canary, from a wallet on Base, USDC contract on Base (verify the token contract address, not just the name). Wait for the credit.
2. [ ] Then send the remaining $4 if the canary credited correctly.

### C. Verify credit

| Check | Expected |
| --- | --- |
| Circle webhook received | 200 in our logs, `deposit:circle-<chain>:<txHash>:0` key |
| Ledger | exactly one credit of 100 cents (canary), balance equals sum of postings |
| Redelivery | replay the webhook from Circle's console: no second credit |
| Dashboard | card balance matches the ledger |
| `ledger_check_balances()` | zero rows |
| Catch-up reconcile (wait one minute) | no new entries, no errors |

### D. Verify top-up and spend

| Check | Expected |
| --- | --- |
| Fund the card by $2 | `app_funding` row goes `reserved` then `completed`; Miden shows the top-up with our reference |
| Miden wallet balance | down by exactly the top-up |
| Over-cap attempt | funding above the lifetime cap ($10 in the test) is refused with the "verify identity" reason |
| Spend within cap | succeeds; `app_spend` row settled; ledger balance down by the amount |
| Spend over per-transaction cap ($2) | declined |
| Failure path | one declined spend leaves no hold |

### E. Edge cases worth trying while we are there (cheap, small amounts)

- [ ] Send **less than one cent** of USDC: not credited, logged once by reconcile, no webhook crash (tmvtjrdxdp covers recording these).
- [ ] Same deposit delivered twice: credited once.
- [ ] Stop the app, send $1, start the app: catch-up credits it within a few minutes.
- [ ] Do **not** send on a wrong network on purpose with real money. That path is tested in sandbox only; it is documented as lost funds.

### F. Wrap up

1. [ ] Record every tx hash, ledger seq, Miden reference.
2. [ ] Leftover USDC stays in the Circle wallet until tmwc0fdun2 (what to do with USDC in card wallets) is decided. Write down how much is there.
3. [ ] Restore tier caps to the real values, or leave low if you prefer.
4. [ ] Add the results to `docs/circle-deposits.md` (replace the "sandbox only" status).

## Stop conditions

Stop and tell the project owner immediately if: the ledger and Miden balances disagree by any amount, a credit appears twice or not at all after 10 minutes, `ledger_check_balances()` returns rows, or any request on the webhook host other than `/webhooks/circle` and `/healthz` returns anything but 404.
