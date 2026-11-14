import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { AgentWallets } from "../src/lib/services/AgentWallets.js";
import { createDepositAddressRepository } from "../src/db/repositories/createChainRepositories.js";
import { DEFAULT_TIERS } from "../src/lib/services/tiers.js";
import type { FundingRequest } from "../src/domain/interfaces/FundingSource.js";
import { Ledger } from "../src/lib/services/Ledger.js";
import { createDatabase } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createRepositories } from "../src/db/repositories/createRepositories.js";
import { createAppServer } from "../src/createHttpServer.js";
import { CardholderInteractor, type CardholderContext } from "../src/lib/interactors/CardholderInteractor.js";
import { DeveloperInteractor, isPrivateAddress } from "../src/lib/interactors/DeveloperInteractor.js";

// Runs only with DATABASE_URL (each case gets its own schema). Miden is faked.
const databaseUrl = process.env.DATABASE_URL;
const skip = !databaseUrl;
const admin = databaseUrl ? new pg.Pool({ connectionString: databaseUrl, max: 2 }) : undefined;
const pools: pg.Pool[] = [];
const schemas: string[] = [];
const servers: { close(): void }[] = [];
after(async () => {
  for (const s of servers) s.close();
  for (const p of pools) await p.end();
  for (const s of schemas) await admin!.query(`DROP SCHEMA ${s} CASCADE`);
  await admin?.end();
});

const KYC = {
  firstName: "Ada", lastName: "Test", dateOfBirth: "1990-01-31", idType: "PASSPORT", idNumber: "X1", phone: "+2348000000000", email: "a@example.com",
  idFrontImage: "data:image/png;base64,AAAA", address: { address1: "1 St", city: "Lagos", state: "Lagos", zipcode: "1", country: "NG" },
};

async function setup(opts: { allowLocalWebhooks?: boolean; fetch?: typeof fetch; resolve?: (h: string) => Promise<string[]> } = {}) {
  const schema = `t_${randomBytes(6).toString("hex")}`;
  await admin!.query(`CREATE SCHEMA ${schema}`);
  schemas.push(schema);
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 6 });
  pools.push(pool);
  await migrate(pool);
  const db = createDatabase(pool);
  const repos = createRepositories(db);
  const ledger = new Ledger(undefined, repos.ledger);
  let cards = 0;
  let clock = Date.now();
  const f = { kyc: "Approved" };
  const deps = {
    lifecycle: { submitKyc: async () => ({ kycStatus: "Initiated" }), kycStatus: async () => ({ status: f.kyc, customerId: "cust-1", kycToken: "kt" }), cardBalance: async () => 0, transactions: async () => [] },
    cardIssuer: { issue: async (_a: string, policy: unknown) => ({ id: `card-${++cards}`, agentId: "x", policy }) },
    funding: { fund: async (_r: FundingRequest) => ({ id: "m1", status: "confirmed" as const }) },
  };
  let dev: DeveloperInteractor | undefined;
  const app = new CardholderInteractor({
    users: repos.users, cards: repos.cards, agents: repos.agents, spends: repos.spends, fundings: repos.fundings, oneTimeCards: repos.oneTimeCards,
    ledger, wallets: new AgentWallets(ledger), addresses: createDepositAddressRepository(db, "base-sepolia"),
    deriveAddress: (i: number) => `0x${i.toString(16).padStart(40, "0")}`, tiers: DEFAULT_TIERS, chain: "base-sepolia", sandbox: true, simulatedDeposits: true,
    now: () => new Date(clock),
    onEvent: (u: string, t: string, d: Record<string, unknown>) => dev?.onEvent(u, t, d) ?? Promise.resolve(),
    ...deps,
  } as unknown as CardholderContext);
  dev = new DeveloperInteractor({
    developers: repos.developers, webhookEvents: repos.webhookEvents, app, allowLocalWebhooks: opts.allowLocalWebhooks ?? false, publicUrl: "https://cards.example", now: () => new Date(clock),
    fetch: opts.fetch, resolve: opts.resolve ?? (async () => ["93.184.216.34"]),
  });
  return { pool, app, dev, f, advance: (ms: number) => (clock += ms) };
}
type S = Awaited<ReturnType<typeof setup>>;

/** Events are queued in the background; wait for the queue to reach n. */
async function eventsQueued(s: S, n: number) {
  for (let i = 0; i < 100; i++) {
    const c = Number((await s.pool.query("SELECT count(*) AS n FROM app_webhook_event")).rows[0].n);
    if (c >= n) return c;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`only ${(await s.pool.query("SELECT count(*) AS n FROM app_webhook_event")).rows[0].n} events queued`);
}

test("a developer's users are idempotent by externalId and invisible to other developers", { skip }, async () => {
  const s = await setup();
  const a = await s.dev.signup({ name: "Shopbot", email: "a@dev.example" });
  const b = await s.dev.signup({ name: "Other", email: "b@dev.example" });
  await assert.rejects(s.dev.signup({ name: "Dup", email: "A@dev.example" }), /already has a developer account/);
  assert.equal(await s.dev.byKey(a.key), a.developerId);
  assert.equal(await s.dev.byKey("dk_nope"), undefined);

  const u1 = await s.dev.createUser(a.developerId, { externalId: "cust-1", email: "c1@example.com" });
  const again = await s.dev.createUser(a.developerId, { externalId: "cust-1", email: "c1@example.com" });
  assert.equal(u1.created, true);
  assert.equal(again.created, false);
  assert.equal(again.user.userId, u1.user.userId);
  assert.equal(u1.user.externalId, "cust-1");
  // The same externalId under another developer is a different user.
  const other = await s.dev.createUser(b.developerId, { externalId: "cust-1", email: "c1b@example.com" });
  assert.notEqual(other.user.userId, u1.user.userId);

  const uid = u1.user.userId;
  await assert.rejects(s.dev.userView(b.developerId, uid), /user not found/);
  await assert.rejects(s.dev.createSession(b.developerId, uid), /user not found/);
  await assert.rejects(s.dev.createAgent(b.developerId, uid, { name: "x", perTransactionCents: 100, dailyCents: 100 }), /user not found/);
  assert.equal((await s.dev.listUsers(a.developerId, 10)).length, 1);
  assert.equal((await s.dev.listUsers(a.developerId, 10, "nobody")).length, 0);
});

test("sessions expire, are scoped to one user, and carry the token in the URL fragment", { skip }, async () => {
  const s = await setup();
  const a = await s.dev.signup({ name: "Shopbot", email: "a@dev.example" });
  const { user } = await s.dev.createUser(a.developerId, { externalId: "c1", email: "c1@example.com" });
  await assert.rejects(s.dev.createSession(a.developerId, user.userId, 5), /ttlSeconds/);
  await assert.rejects(s.dev.createSession(a.developerId, user.userId, 10 ** 7), /ttlSeconds/);
  const sess = await s.dev.createSession(a.developerId, user.userId, 600);
  assert.match(sess.token, /^us_/);
  assert.equal(sess.url, `https://cards.example/connect#session=${sess.token}`);
  assert.equal(await s.app.userBySession(sess.token), user.userId);
  s.advance(601_000);
  assert.equal(await s.app.userBySession(sess.token), undefined);
  assert.equal(await s.app.userBySession("us_garbage"), undefined);
  // The raw token is never stored.
  const stored = await s.pool.query("SELECT token_hash FROM app_session");
  assert.ok(stored.rows.every((r) => r.token_hash !== sess.token));
});

test("the developer can run a user's agents and limits, but only inside the user's card", { skip }, async () => {
  const s = await setup();
  const a = await s.dev.signup({ name: "Shopbot", email: "a@dev.example" });
  const { user } = await s.dev.createUser(a.developerId, { externalId: "c1", email: "c1@example.com" });
  await assert.rejects(s.dev.createAgent(a.developerId, user.userId, { name: "bot", perTransactionCents: 100, dailyCents: 100 }), /complete KYC first/);
  // The end user does KYC in their own session; the developer never handles identity data.
  await s.app.submitKyc(user.userId, KYC);
  await s.app.refresh(user.userId);
  const agent = await s.dev.createAgent(a.developerId, user.userId, { name: "bot", perTransactionCents: 1_000, dailyCents: 3_000, allowedMccs: ["5734"] });
  assert.match(agent.token, /^ak_/);
  const tight = await s.dev.updateAgentLimits(a.developerId, user.userId, agent.agentId, { perTransactionCents: 500 });
  assert.equal(tight.perTransactionCents, 500);
  await assert.rejects(
    s.dev.updateAgentLimits(a.developerId, user.userId, agent.agentId, { perTransactionCents: DEFAULT_TIERS.quick.perTransactionCents + 1 }),
    /per-payment limit can be at most/,
  );
  await s.dev.revokeAgent(a.developerId, user.userId, agent.agentId);
  assert.equal(await s.app.agentByToken(agent.token), undefined);
});

test("webhooks: signed, retried with backoff, and queued only for users who have a developer with a URL", { skip }, async () => {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  let status = 500;
  const fakeFetch = (async (url: URL, init: RequestInit) => {
    calls.push({ url: String(url), headers: init.headers as Record<string, string>, body: String(init.body) });
    return new Response("", { status });
  }) as unknown as typeof fetch;
  const s = await setup({ fetch: fakeFetch });
  const a = await s.dev.signup({ name: "Shopbot", email: "a@dev.example" });
  const { user } = await s.dev.createUser(a.developerId, { externalId: "c1", email: "c1@example.com" });

  // No URL yet: nothing is queued.
  await s.app.submitKyc(user.userId, KYC);
  await s.app.refresh(user.userId);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(Number((await s.pool.query("SELECT count(*) AS n FROM app_webhook_event")).rows[0].n), 0);

  await assert.rejects(s.dev.updateSettings(a.developerId, { webhookUrl: "http://example.com/hook" }), /https/);
  await assert.rejects(s.dev.updateSettings(a.developerId, { webhookUrl: "https://user:pw@example.com/hook" }), /credentials/);
  const set = await s.dev.updateSettings(a.developerId, { webhookUrl: "https://hooks.example.com/agent-cards" });
  assert.match(set.webhookSecret!, /^whsec_/);
  assert.equal((await s.dev.profile(a.developerId)).webhookUrl, "https://hooks.example.com/agent-cards");

  // A deposit that gets funded onto the card: funding.completed.
  await s.app.simulateDeposit(user.userId, 2_000);
  await s.app.fundPending();
  await eventsQueued(s, 1);

  await s.dev.deliverDue();
  assert.equal(calls.length, 1);
  const c = calls[0]!;
  assert.equal(c.url, "https://hooks.example.com/agent-cards");
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(c.headers["x-agentcards-signature"]!);
  assert.ok(m, "signature header has the t=,v1= shape");
  assert.equal(c.headers["x-agentcards-signature"], DeveloperInteractor.sign(set.webhookSecret!, Number(m![1]), c.body));
  const body = JSON.parse(c.body);
  assert.equal(body.type, "funding.completed");
  assert.equal(body.externalId, "c1");
  assert.equal(body.data.amountCents, 2_000);
  assert.equal(c.headers["x-agentcards-event-id"], body.id);

  // 500 -> still pending with backoff; not retried before it is due.
  let ev = (await s.dev.listEvents(a.developerId, 10))[0]!;
  assert.equal(ev.status, "pending");
  assert.equal(ev.attempts, 1);
  await s.dev.deliverDue();
  assert.equal(calls.length, 1, "backoff holds the retry");
  status = 200;
  s.advance(31_000);
  await s.dev.deliverDue();
  assert.equal(calls.length, 2);
  ev = (await s.dev.listEvents(a.developerId, 10))[0]!;
  assert.equal(ev.status, "delivered");
  assert.equal(calls[1]!.headers["x-agentcards-event-id"], calls[0]!.headers["x-agentcards-event-id"], "a retry is the same event");
  // Event listings never show payloads or secrets.
  assert.ok(!JSON.stringify(ev).includes("whsec_"));
  assert.ok(!("body" in ev));
});

test("webhooks give up after repeated failures and never go to private addresses", { skip }, async () => {
  const fakeFetch = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
  const s = await setup({ fetch: fakeFetch });
  const a = await s.dev.signup({ name: "Shopbot", email: "a@dev.example" });
  const { user } = await s.dev.createUser(a.developerId, { externalId: "c1", email: "c1@example.com" });
  await s.dev.updateSettings(a.developerId, { webhookUrl: "https://hooks.example.com/x" });
  await s.app.submitKyc(user.userId, KYC);
  await s.app.refresh(user.userId);
  await eventsQueued(s, 1);
  for (let i = 0; i < 10; i++) {
    await s.dev.deliverDue();
    s.advance(7 * 3_600_000);
  }
  const ev = (await s.dev.listEvents(a.developerId, 10))[0]!;
  assert.equal(ev.status, "failed");
  assert.equal(ev.attempts, 8);
  assert.equal(ev.lastError, "HTTP 503");

  // A hostname that resolves inside our network is refused when set, and at delivery too.
  const t = await setup({ resolve: async () => ["10.0.0.5"] });
  const d = await t.dev.signup({ name: "Evil", email: "e@dev.example" });
  await assert.rejects(t.dev.updateSettings(d.developerId, { webhookUrl: "https://internal.example.com/x" }), /public address/);
  assert.equal(isPrivateAddress("169.254.169.254"), true);
  assert.equal(isPrivateAddress("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateAddress("93.184.216.34"), false);
  // Sandbox mode lets a developer test against their own machine.
  const l = await setup({ allowLocalWebhooks: true });
  const ld = await l.dev.signup({ name: "Local", email: "l@dev.example" });
  assert.equal((await l.dev.updateSettings(ld.developerId, { webhookUrl: "http://localhost:4000/hook" })).webhookUrl, "http://localhost:4000/hook");
});

test("privacy mode is a developer setting that defaults off", { skip }, async () => {
  const s = await setup();
  const a = await s.dev.signup({ name: "Shopbot", email: "a@dev.example" });
  assert.equal(await s.dev.privacyMode(a.developerId), false);
  await assert.rejects(s.dev.updateSettings(a.developerId, { privacyMode: "yes" }), /true or false/);
  assert.equal((await s.dev.updateSettings(a.developerId, { privacyMode: true })).privacyMode, true);
  assert.equal(await s.dev.privacyMode(a.developerId), true);
});

test("HTTP: developer key, session and owner token each open only their own door", { skip }, async () => {
  const s = await setup();
  // The server only answers its allowed Host values, so find a free port first.
  const probe = createAppServer({ cardholders: s.app }, { allowedHosts: [] });
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const hosts = [`127.0.0.1:${port}`];
  const real = createAppServer({ cardholders: s.app, developers: s.dev }, { allowedHosts: hosts });
  await new Promise<void>((r) => real.listen(port, "127.0.0.1", r));
  servers.push(real);
  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };

  const signup = await call("POST", "/developer/v1/signup", undefined, { name: "Shopbot", email: "a@dev.example" });
  assert.equal(signup.status, 201);
  const key = signup.json.key as string;
  assert.equal((await call("GET", "/developer/v1/me")).status, 401);
  assert.equal((await call("GET", "/developer/v1/me", "dk_wrong")).status, 401);
  assert.equal((await call("GET", "/developer/v1/me", key)).json.privacyMode, false);

  const made = await call("POST", "/developer/v1/users", key, { externalId: "c1", email: "c1@example.com" });
  assert.equal(made.status, 201);
  assert.equal((await call("POST", "/developer/v1/users", key, { externalId: "c1", email: "c1@example.com" })).status, 200);
  const uid = made.json.userId as string;
  // A managed user has no owner token to hand out or guess; the developer key is not a user token either.
  assert.equal((await call("GET", "/api/me", key)).status, 401);

  const sess = await call("POST", `/developer/v1/users/${uid}/sessions`, key, {});
  assert.equal(sess.status, 201);
  const token = sess.json.token as string;
  const me = await call("GET", "/api/me", token);
  assert.equal(me.status, 200);
  assert.equal(me.json.userId, uid);
  assert.equal((await call("POST", "/api/me/kyc", token, KYC)).status, 200);
  // A session must not mint a permanent token.
  assert.equal((await call("POST", "/api/me/token", token, {})).status, 401);
  // A session is not a developer key.
  assert.equal((await call("GET", "/developer/v1/me", token)).status, 401);
  // Another developer cannot reach this user.
  const other = await call("POST", "/developer/v1/signup", undefined, { name: "Other", email: "b@dev.example" });
  assert.equal((await call("GET", `/developer/v1/users/${uid}`, other.json.key)).status, 404);
  assert.equal((await call("POST", `/developer/v1/users/${uid}/sessions`, other.json.key, {})).status, 404);
});

test("the SSRF guard rejects every IPv6 form that wraps a private IPv4 address", () => {
  for (const ip of ["::ffff:7f00:1", "::ffff:a9fe:a9fe", "::ffff:10.0.0.5", "64:ff9b::7f00:1", "::127.0.0.1", "fec0::1", "fe80::1", "fd00::1", "::1", "::", "2002:7f00:1::1", "ff02::1",
    "198.18.0.1", "224.0.0.1", "192.0.0.1", "100.64.0.1", "0.0.0.0", "not-an-ip"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["93.184.216.34", "8.8.8.8", "2606:2800:220:1:248:1893:25c8:1946", "::ffff:5db8:d822", "2002:5db8:d822::1"]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test("revoking sessions ends them, and rotating the developer key ends all of the developer's sessions", { skip }, async () => {
  const s = await setup();
  const a = await s.dev.signup({ name: "Shopbot", email: "r@dev.example" });
  const b = await s.dev.signup({ name: "Other", email: "r2@dev.example" });
  const { user } = await s.dev.createUser(a.developerId, { externalId: "c1", email: "r1@example.com" });
  const s1 = await s.dev.createSession(a.developerId, user.userId, 600);
  assert.deepEqual(await s.dev.revokeSessions(a.developerId, user.userId), { revoked: 1 });
  assert.equal(await s.app.userBySession(s1.token), undefined);
  await assert.rejects(s.dev.revokeSessions(b.developerId, user.userId), /not found/);
  const s2 = await s.dev.createSession(a.developerId, user.userId, 600);
  await s.dev.rotateKey(a.developerId);
  assert.equal(await s.app.userBySession(s2.token), undefined);
});
