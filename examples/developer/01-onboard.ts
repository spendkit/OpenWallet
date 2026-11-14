// Demo 1: the whole developer path, headless. Sign up, create a user, hand them a connect link, then
// (sandbox shortcut) do the user's KYC and deposit for them, create an agent with limits, fund it, and show the agent's wallet.
// MOVES SANDBOX MONEY (a few dollars). Needs the service running (pnpm dev:up).
// Run: node --import tsx examples/developer/01-onboard.ts   -> writes examples/developer/.env.developer-demo (git-ignored)
import { call, developerKey, kycAsUser, newAgent, newUser, ok, say, saveState, simulatedDeposit } from "./lib.ts";

const dk = await developerKey();
const { userId, externalId, session, connectUrl } = await newUser(dk);
say(`1. user ${userId} created for your customer "${externalId}".`);
say(`2. In real use you send them to the hosted page for KYC and spend controls (the session is in the URL fragment, so no server log sees it):\n   ${connectUrl.split("#")[0]}#session=<us_ token, not printed>`);

say("3. Sandbox shortcut: doing the user's KYC and a $25 deposit ourselves (dummy identity)...");
await kycAsUser(session, externalId);
await simulatedDeposit(session, 2_500);

const agent = await newAgent(dk, userId, { perTransactionCents: 2_000, dailyCents: 10_000, allowedMccs: ["5734", "5815"] }, 2_000);
say(`4. agent ${agent.agentId} created ($20 per payment, $100 per day, software/digital MCCs) and given $20.`);

const wallet = await ok("agent wallet", call("GET", "/agent/v1/wallet", agent.token));
say(`5. the agent sees: ${JSON.stringify(wallet)}`);

const view = await ok("user view", call("GET", `/developer/v1/users/${userId}`, dk));
say(`6. you see: tier=${view.tier} kyc=${view.kycStatus} privacyMode=${view.privacyMode}`);

saveState({ DEMO_USER_ID: userId, DEMO_AGENT_ID: agent.agentId, DEMO_AGENT_TOKEN: agent.token, DEMO_SESSION: session });
say("\nSaved the agent token and ids to examples/developer/.env.developer-demo. Next: 02-limits.ts, agent-mcp.ts");
