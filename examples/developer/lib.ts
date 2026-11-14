// Shared helpers for the developer demos. Sandbox only. Secrets are read from env or the git-ignored .env.developer-demo and never printed.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const baseUrl = (process.env.AGENT_CARDS_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const stateFile = fileURLToPath(new URL("./.env.developer-demo", import.meta.url));

export const say = (s: string) => console.log(s);
export const fail = (s: string): never => { console.error(`\nERROR: ${s}`); process.exit(1); };
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function readState(): Record<string, string> {
  if (!existsSync(stateFile)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(stateFile, "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

export function saveState(patch: Record<string, string>): void {
  const all = { ...readState(), ...patch };
  writeFileSync(stateFile, Object.entries(all).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
  chmodSync(stateFile, 0o600);
}

/** One JSON call. Returns the status and body instead of throwing, so demos can show a refusal (the point of some of them). */
export async function call<T = any>(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; data: T }> {
  let res: Response;
  try {
    res = await fetch(baseUrl + path, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return fail(`cannot reach ${baseUrl}. Start the service: pnpm dev:up`);
  }
  return { status: res.status, data: (await res.json().catch(() => ({}))) as T };
}

export async function ok<T = any>(what: string, r: Promise<{ status: number; data: T }>, expect = 200): Promise<T> {
  const { status, data } = await r;
  if (status !== expect && !(expect === 201 && status === 200)) fail(`${what}: ${status} ${JSON.stringify(data)}`);
  return data;
}

export async function until<T>(what: string, read: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 120_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await read();
    if (done(v)) return v;
    if (Date.now() > end) fail(`timed out waiting for ${what} (service log: .run/server.log)`);
    await sleep(2_000);
  }
}

/** The developer key: DEVELOPER_KEY from the env, else the saved one, else sign up (the key is shown once, so it is saved). */
export async function developerKey(name = "Demo Shopbot"): Promise<string> {
  const have = process.env.DEVELOPER_KEY ?? readState().DEVELOPER_KEY;
  if (have && (await call("GET", "/developer/v1/me", have)).status === 200) return have;
  const s = await ok("developer signup", call("POST", "/developer/v1/signup", undefined, { name, email: `dev+${Date.now()}@example.com` }), 201);
  saveState({ DEVELOPER_KEY: s.key });
  say("signed up a sandbox developer (key saved to examples/developer/.env.developer-demo)");
  return s.key;
}

/**
 * SANDBOX SHORTCUT. In real use your user does KYC in the hosted /connect page. A demo has no browser,
 * so this does what that page does, with a dummy identity, using the user's own short-lived session.
 */
export async function kycAsUser(session: string, tag: string): Promise<void> {
  const n = tag.replace(/\D/g, "").slice(-8).padStart(8, "1");
  await ok("card KYC", call("POST", "/api/me/kyc", session, {
    firstName: "Demo", lastName: `User${n.slice(-4)}`, dateOfBirth: "1990-01-31", idType: "PASSPORT", idNumber: `D${n}`,
    phone: `+23481${n}`, email: `demo+${n}@example.com`,
    idFrontImage: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    address: { address1: "1 Test Street", city: "Lagos", state: "Lagos", zipcode: "100001", country: "NG" },
  }));
  await until("the card to be issued", async () => (await call("POST", "/api/me/refresh", session)).data, (d: any) => d.card?.deposit?.address);
}

/** SANDBOX SHORTCUT: a simulated USDC deposit (needs ALLOW_SIMULATED_DEPOSITS=1, which pnpm dev:up sets), waits for the card top-up. */
export async function simulatedDeposit(session: string, amountCents: number): Promise<void> {
  const r = await call("POST", "/api/me/simulate-deposit", session, { amountCents });
  if (r.status !== 202) fail(`simulated deposit refused (${r.status}: ${r.data?.error ?? "no detail"}). Start the service with ALLOW_SIMULATED_DEPOSITS=1.`);
  const d: any = await until("the card top-up", async () => (await call("GET", "/api/me", session)).data, (v: any) => v.card.fundings.some((f: any) => f.status !== "reserved"));
  if (d.card.fundings[0].status !== "completed") fail(`top-up ended ${d.card.fundings[0].status}`);
}

export async function newUser(dk: string, opts: { privacyMode?: boolean } = {}) {
  const externalId = `demo-${Date.now()}`;
  const user = await ok("create user", call("POST", "/developer/v1/users", dk, { externalId, email: `${externalId}@example.com`, ...opts }), 201);
  const userId = user.userId as string;
  const sess = await ok("create session", call("POST", `/developer/v1/users/${userId}/sessions`, dk, { ttlSeconds: 3600 }), 201);
  return { userId, externalId, session: sess.token as string, connectUrl: sess.url as string };
}

/** Create an agent with limits and give it money from the user's card. Returns the ak_ token (shown once). */
export async function newAgent(dk: string, userId: string, limits: { perTransactionCents: number; dailyCents: number; allowedMccs?: string[] }, budgetCents: number) {
  const a = await ok("create agent", call("POST", `/developer/v1/users/${userId}/agents`, dk, { name: "demo-shopper", ...limits }), 201);
  await ok("fund agent", call("POST", `/developer/v1/users/${userId}/agents/${a.agentId}/fund`, dk, { amountCents: budgetCents }));
  return { agentId: a.agentId as string, token: a.token as string };
}
