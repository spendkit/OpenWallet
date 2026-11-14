# Runbook (short)

Alerts go to the log always, and to `ALERT_WEBHOOK_URL` (Slack-compatible) when set. Each alert fires once, repeats at most hourly while the problem lasts, and sends one `RECOVERED` line when it clears. What alerts: Circle webhook failures, Circle catch-up reconcile errors, top-ups stuck in `reserved`, Miden USD wallet low balance. There is no cursor-lag or reorg alert by design.

## A Circle webhook was missed or arrived late

Symptom: a user says they sent USDC on Base and the card shows nothing; or an alert `Circle webhook failed`.

1. A late webhook is harmless. Circle retries a non-2xx, and the credit is keyed on the transfer, so a repeat is a no-op.
2. The server also catches up by itself: once a minute it lists Circle's COMPLETE inbound USDC transfers from the **last 2 hours** and credits any the ledger has not seen. Log lines: `circle reconcile: credited N missed deposit(s)`. If nothing is wrong this heals within about a minute of the service being back.
3. Alert `Circle catch-up reconcile is failing: <reason>`: the reason is Circle's answer. 401/403 means the API key or entity secret is wrong or revoked; 429/5xx means wait; anything else, read the full log line. Until it works, only webhooks credit deposits.
4. Outage longer than 2 hours (tunnel or server down overnight): run the catch-up by hand with a longer window, where the server's environment (`DATABASE_URL`, `CIRCLE_*`) is set:

   ```
   pnpm circle:reconcile -- 72      # hours back, 1 to 2160
   ```

   It prints how many transfers it listed and how many were newly credited, plus any it would not credit and why. Safe to repeat. The running server picks up the credited money on its next funding pass; no restart. Paging stops at 500 transfers; if it warns about that, run a shorter window (the newest 500 are the ones it reads).
5. Still missing after that: find the transfer in Circle's console (wallet address, state). `PENDING` or `CONFIRMED` is not credited yet; only `COMPLETE` counts. Check the log for `not credited (<reason>)`: wrong token, unsupported chain, odd shape.

## Sub-cent dust

A transfer under one cent has no ledger entry (a ledger transaction needs whole cents). It is logged once per process as `dust <n> base units on <txHash> (not credited)`. Nothing to do: the money stays in that card's Circle wallet. Tell the user it was too small to credit. After a restart a transfer still inside the 2-hour window is logged once more.

## Deposit on the wrong network

Circle wallets here only see Base USDC. USDC on another chain, USDT, or a different token sent to the deposit address is never reported to us, so nothing is credited and no log line appears.

1. Get the chain and transaction hash from the user and confirm it on a block explorer (right address, amount, chain).
2. Do **not** credit it by hand or promise a time. We cannot move it from our side.
3. Ask Circle support whether that wallet can recover it on that chain, giving the wallet id, address and hash. A different token on Base itself shows in reconcile as `not the pinned USDC contract`.
4. The dashboard should show "Base USDC only" (todo tmwc0fdun6) so this happens less.

## Top-up stuck in `reserved`

Alert: `N card top-up(s) stuck in 'reserved' for over 15 min`. A top-up row is `reserved` only between the ledger reserve and Miden's answer; the next funding pass (every 5 s) normally settles it, so one that lingers is being retried and failing.

1. Look at the log for `funding <id> will retry: <reason>` and `funding:` errors. The usual causes: Miden wallet balance too low (also alerts), Miden API errors or credentials.
2. Query the row: `SELECT * FROM app_funding WHERE status = 'reserved' ORDER BY created_at;` (`detail` and `updated_at` show the last attempt).
3. Younger than 20 hours, the server re-sends with the same Reference header, so Miden lands it at most once. Fix the cause and it finishes on its own.
4. Older than 20 hours the server stops re-sending (a re-send could top up twice) and only looks for the original top-up on Miden. If that finds nothing the row stays reserved. Then check the card's Miden transactions for that amount by hand before deciding: landed (complete it) or not (release it). Both move ledger money (`completeFunding` / `releaseFunding`), so do not just edit the row; get Val. Never release without checking Miden.
