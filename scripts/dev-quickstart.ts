// Developer quickstart: gives you sandbox keys in one command, then proves they work.
//   1. a funded test agent (ak_...): signs up a test user, dummy Card KYC, simulated $25 deposit, Miden top-up, agent with a budget
//   2. a merchant account (mk_...)
//   3. a $1.00 checkout created with the SDK and paid by that agent, so you see "paid" before writing any code
// Keys go to .env.sandbox-keys (mode 600, git-ignored); nothing secret is printed.
// Needs the service running (pnpm dev:up) with ALLOW_SIMULATED_DEPOSITS=1 (the default there).
// Moves a few dollars of sandbox money (mock balance, or Miden sandbox balance if MIDEN_* is set).
// Run: node --import tsx scripts/dev-quickstart.ts [--url http://127.0.0.1:8787] [--fresh] [--no-pay]
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AgentCardsAgent, AgentCardsCheckout, AgentCardsError } from "../sdk/checkout/src/index.ts";

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const urlIdx = args.indexOf("--url");
const baseUrl = (urlIdx >= 0 ? args[urlIdx + 1] : process.env.AGENT_CARDS_URL ?? "http://127.0.0.1:8787")?.replace(/\/$/, "") ?? "";
const keysFile = fileURLToPath(new URL("../.env.sandbox-keys", import.meta.url));

const say = (s: string) => console.log(s);
const fail = (s: string): never => { console.error(`\nERROR: ${s}`); process.exit(1); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api<T = any>(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; data: T }> {
  let res: Response;
  try {
    res = await fetch(baseUrl + path, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return fail(`cannot reach ${baseUrl}. Start the service first: pnpm dev:up`);
  }
  return { status: res.status, data: (await res.json().catch(() => ({}))) as T };
}

async function until<T>(what: string, read: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 120_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await read();
    if (done(v)) return v;
    if (Date.now() > end) fail(`timed out waiting for ${what}. The service log is .run/server.log.`);
    await sleep(2_000);
  }
}

function readKeys(): Record<string, string> {
  if (!existsSync(keysFile)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(keysFile, "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

function saveKeys(k: Record<string, string>): void {
  const lines = [
    "# Sandbox keys written by scripts/dev-quickstart.ts. Sandbox only; git-ignored. Load with: node --env-file=.env.sandbox-keys ...",
    ...Object.entries(k).map(([key, v]) => `${key}=${v}`),
  ];
  writeFileSync(keysFile, lines.join("\n") + "\n", { mode: 0o600 });
  chmodSync(keysFile, 0o600);
}

// --- Is the service up, and is it the sandbox? ---
const health = await api("GET", "/healthz");
if (health.status !== 200) fail(`${baseUrl}/healthz answered ${health.status}. Is the service running? pnpm dev:up`);

let keys = flag("--fresh") ? {} : readKeys();

// Reuse keys from an earlier run if they still work.
let agentOk = false;
let merchantOk = false;
if (keys.AGENT_CARDS_AGENT_TOKEN) agentOk = (await api("GET", "/agent/v1/wallet", keys.AGENT_CARDS_AGENT_TOKEN)).status === 200;
if (keys.AGENT_CARDS_SECRET_KEY) merchantOk = (await api("GET", "/merchant/v1/me", keys.AGENT_CARDS_SECRET_KEY)).status === 200;

if (!agentOk) {
  const n = Date.now().toString().slice(-8);
  say("1/3 Creating a funded test agent (dummy identity, simulated USDC deposit; takes about a minute)...");
  const signup = await api("POST", "/api/signup", undefined, { email: `dev+${n}@example.com` });
  if (signup.status !== 201) fail(`signup failed: ${JSON.stringify(signup.data)}`);
  const user = signup.data.token as string;

  const kyc = await api("POST", "/api/me/kyc", user, {
    firstName: "Dev", lastName: `Quickstart${n.slice(-4)}`, dateOfBirth: "1990-01-31", idType: "PASSPORT", idNumber: `Q${n}`,
    phone: `+23481${n}`, email: `dev+${n}@example.com`,
    idFrontImage: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    address: { address1: "1 Test Street", city: "Lagos", state: "Lagos", zipcode: "100001", country: "NG" },
  });
  if (kyc.status !== 200) fail(`Card KYC was refused: ${JSON.stringify(kyc.data)}`);

  await until("the card to be issued", async () => (await api("POST", "/api/me/refresh", user)).data, (d: any) => d.card?.deposit?.address);

  const dep = await api("POST", "/api/me/simulate-deposit", user, { amountCents: 2_500 });
  if (dep.status !== 202) {
    fail(`simulated deposit refused (${dep.status}: ${dep.data?.error ?? "no detail"}). The service must run with ALLOW_SIMULATED_DEPOSITS=1 (pnpm dev:up sets it).`);
  }
  const funded = await until("the Miden top-up", async () => (await api("GET", "/api/me", user)).data, (d: any) => d.card.fundings.some((f: any) => f.status !== "reserved"));
  if (funded.card.fundings[0].status !== "completed") fail(`the card top-up did not complete: ${funded.card.fundings[0].status} ${funded.card.fundings[0].detail ?? ""}`);

  const agent = await api("POST", "/api/me/agents", user, { name: "dev-quickstart-agent", perTransactionCents: 1_000, dailyCents: 1_500 });
  if (agent.status !== 201) fail(`could not create the agent: ${JSON.stringify(agent.data)}`);
  const give = await api("POST", `/api/me/agents/${agent.data.agentId}/fund`, user, { amountCents: 2_000 });
  if (give.status !== 200) fail(`could not give the agent a budget: ${JSON.stringify(give.data)}`);
  keys = { ...keys, AGENT_CARDS_URL: baseUrl, AGENT_CARDS_AGENT_TOKEN: agent.data.token as string };
  saveKeys(keys);
  say("    agent ready: $20 budget, $10 per payment, $15 per day");
} else {
  say("1/3 Reusing the test agent from the last run (--fresh makes a new one)");
}

if (!merchantOk) {
  say("2/3 Creating a merchant account...");
  const m = await AgentCardsCheckout.signup({ baseUrl }, { name: "Dev Quickstart Shop", email: "dev-merchant@example.com", mcc: "5734" });
  keys = { ...keys, AGENT_CARDS_URL: baseUrl, AGENT_CARDS_SECRET_KEY: m.secretKey };
  saveKeys(keys);
} else {
  say("2/3 Reusing the merchant from the last run");
}

if (!flag("--no-pay")) {
  say("3/3 Proving it end to end: the agent pays a $1.00 checkout...");
  const merchant = new AgentCardsCheckout({ baseUrl, secretKey: keys.AGENT_CARDS_SECRET_KEY! });
  const agent = new AgentCardsAgent({ baseUrl, token: keys.AGENT_CARDS_AGENT_TOKEN! });
  const ref = `quickstart-${Date.now()}`;
  try {
    const c = await merchant.createCheckout({ amountCents: 100, description: "Quickstart test", reference: ref, idempotencyKey: ref });
    const { payment } = await agent.payCheckout(c.checkoutId, { maxAmountCents: 100 });
    const done = await merchant.waitForPayment(c.checkoutId, { timeoutMs: 60_000 });
    if (done.status !== "paid") fail(`the checkout ended ${done.status} (payment ${payment.status}${payment.reason ? `: ${payment.reason}` : ""}). Check the agent's balance with the dashboard at ${baseUrl}.`);
    say(`    ${c.checkoutId} is paid. Your SDK and keys work.`);
  } catch (e) {
    if (e instanceof AgentCardsError) fail(`${e.status}: ${e.message}`);
    throw e;
  }
}

say(`
Done. Keys are in .env.sandbox-keys (AGENT_CARDS_URL, AGENT_CARDS_SECRET_KEY, AGENT_CARDS_AGENT_TOKEN).
Use them:   node --env-file=.env.sandbox-keys --import tsx your-script.ts
Sample shop: cd examples/shop && node --env-file=../../.env.sandbox-keys --import tsx server.ts
Guide:      docs/getting-started.md`);
