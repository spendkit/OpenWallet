# Demo guide: Agent Cards (sandbox)

Sandbox only. No real money moves.

## 0. Before you start (one-time check)

Miden only accepts calls from a whitelisted IP. If the IP of this machine changes (new Wi-Fi, hotspot), every Miden call fails with `Invalid Source`.

```
curl -s https://api.ipify.org        # your current public IP
```

That IP must be on the whitelist in the Miden sandbox dashboard. Last known whitelisted IP: `102.90.125.46`.

## 1. Start the service

```
cd path/to/your/clone
pnpm dev:up                           # Postgres + service on http://127.0.0.1:8787
curl -s http://127.0.0.1:8787/healthz   # should print {"ok":true}
```

Uses the mock card provider unless `MIDEN_*` is set. Logs: `.run/server.log`. Stop: `pnpm dev:down`.

## 2. Get a funded test agent in one command

```
node --import tsx scripts/dev-quickstart.ts --fresh
```

Takes about a minute. It signs up a test user, does dummy KYC, simulates a $25 USDC deposit, tops up the card, creates an agent with a budget, then has the agent pay a $1.00 checkout and prints `paid`. Keys are written to `.env.sandbox-keys` (git-ignored). Drop `--fresh` to reuse the last agent.

## 3. Show it (suggested order, about 3 minutes)

1. **Dashboard**: open http://127.0.0.1:8787/app. Show the card, the balance and the agent with its spend policy.
2. **Agent pays over REST** (use the `ak_...` token from `.env.sandbox-keys`; do not paste it on screen):
   ```
   curl -s http://127.0.0.1:8787/agent/v1/pay \
     -H "Authorization: Bearer $AGENT_TOKEN" -H "content-type: application/json" \
     -d '{"amountCents":500,"merchant":"Example API","mcc":"5734","idempotencyKey":"demo-1"}'
   ```
3. **Refresh the dashboard**: balance drops, transaction shows.
4. **Show a policy block**: pay more than the agent's budget and show it is refused.
5. **Optional, MCP**: connect an agent client to the same service:
   ```
   claude mcp add --transport http agent-cards http://127.0.0.1:8787/mcp --header "Authorization: Bearer ak_..."
   ```

## Demo B: a developer builds a shopping agent, anyone can KYC and use it

This is the "Shopbot" journey (see `docs/developers.md` and `examples/developer/`). Story: a developer ships a shopping agent. Their users each do KYC once on our hosted page, fund a card, set limits, and the agent shops within them.

**Easiest: run it as a script** (service must be up, step 1; about 1 minute, moves ~$25 of sandbox money):

```
node --import tsx examples/developer/01-onboard.ts
```

It signs up the developer (`dk_` key), creates a user, mints a `/connect` session, does KYC with a dummy identity, funds the card, creates an agent with limits and reads its wallet. Keys go to `examples/developer/.env.developer-demo` (git-ignored, never printed).

Then, in order:

```
node --env-file=examples/developer/.env.developer-demo --import tsx examples/developer/agent-mcp.ts   # agent lists tools, checks wallet, pays $0.50 over MCP
node --import tsx examples/developer/01-onboard.ts                                                   # run again first if you ran 02
node --env-file=examples/developer/.env.developer-demo --import tsx examples/developer/02-limits.ts  # refusals: over limit, wrong category; pause/revoke
```

**Live version, with a real person doing KYC in the browser (the "others can use it" part):**

1. Run `01-onboard.ts` once so the developer exists, then mint a fresh session for a new user:
   ```
   set -a; . examples/developer/.env.developer-demo; set +a   # loads the dk_ key (names are in that file)
   curl -s -X POST localhost:8787/developer/v1/users -H "authorization: Bearer $DK" -H 'content-type: application/json' \
     -d '{"externalId":"guest-1","email":"guest-1@example.com"}'          # -> userId
   curl -s -X POST localhost:8787/developer/v1/users/$USER_ID/sessions -H "authorization: Bearer $DK" \
     -H 'content-type: application/json' -d '{"ttlSeconds":3600}'          # -> url
   ```
2. Open the returned `url` (the `/connect` page). The guest fills in KYC. Sandbox dummy identity that works: Demo User, DOB 1990-01-31, passport `D12345678`, phone `+2348112345678`, 1 Test Street, Lagos, NG.
3. Once approved the page shows the card and a deposit address. In the sandbox, use the simulated deposit to fund it.
4. Developer creates the agent for that user (`POST /developer/v1/users/$USER_ID/agents`) and funds it (`.../fund`). Give the `ak_` token to the shopping agent.
5. The guest changes limits or pauses the agent on `/connect`; the next payment obeys.

Check the exact variable names in `examples/developer/.env.developer-demo` before the demo (do not display the file on screen).

## If something breaks

| Symptom | Fix |
| --- | --- |
| `Invalid Source` from Miden | Public IP not whitelisted. See step 0. |
| `cannot reach http://127.0.0.1:8787` | Run `scripts/sandbox-up.sh`. |
| Quickstart says checkout ended `open` | Stale agent from an old run. Re-run with `--fresh`. |
| Watcher log says `eth_getLogs ... pruned history unavailable` | Harmless for the demo. Deposits are simulated. |

## Known limits

- `CARD_VAULT_KEY` is not set, so full card numbers are not captured and checkout swaps are off. Agent payments through `/agent/v1/pay` and MCP still work.
