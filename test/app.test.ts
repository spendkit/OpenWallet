import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import pg from "pg";
import { AgentWallets } from "../src/lib/services/AgentWallets.js";
import { createDepositAddressRepository } from "../src/db/repositories/createChainRepositories.js";
import { DEFAULT_TIERS } from "../src/lib/services/tiers.js";
import { MidenDuplicateReferenceError } from "../src/adapters/funding/MidenWalletFunding.js";
import type { FundingRequest } from "../src/domain/interfaces/FundingSource.js";
import { Ledger, accounts } from "../src/lib/services/Ledger.js";
import { createDatabase } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createRepositories } from "../src/db/repositories/createRepositories.js";
import { MidenApiError } from "../src/lib/clients/cardIssuing/miden/MidenClient.js";
import { createAppServer } from "../src/createHttpServer.js";
import { CardholderInteractor, midFor, type CardholderContext } from "../src/lib/interactors/CardholderInteractor.js";

// Runs only with DATABASE_URL (each case gets its own schema). Miden is faked; the sandbox run is scripts/sandbox-demo.ts.
const databaseUrl = process.env.DATABASE_URL;
const skip = !databaseUrl;
const admin = databaseUrl ? new pg.Pool({ connectionString: databaseUrl, max: 2 }) : undefined;
const pools: pg.Pool[] = [];
const schemas: string[] = [];
after(async () => {
  for (const p of pools) await p.end();
  for (const s of schemas) await admin!.query(`DROP SCHEMA ${s} CASCADE`);
  await admin?.end();
});

const KYC = {
  firstName: "Ada", lastName: "Test", dateOfBirth: "1990-01-31", idType: "PASSPORT", idNumber: "X1", phone: "+2348000000000", email: "a@example.com",
  idFrontImage: "data:image/png;base64,AAAA", address: { address1: "1 St", city: "Lagos", state: "Lagos", zipcode: "1", country: "NG" },
};

/** A fake Miden with switches for the failure paths. */
function fakeMiden() {
  const f = {
    kyc: "Approved",
    authorize: "approve" as "approve" | "decline" | "hang",
    fund: [] as ("ok" | "timeout" | "duplicate" | "reject")[],
    fundCalls: [] as FundingRequest[],
    authCalls: 0,
    cardsIssued: 0,
    /** The card's transaction list, as Miden would return it. */
    txns: [] as Record<string, unknown>[],
    /** On "hang", the authorization still happened on the card before the answer was lost. */
    chargedOnHang: true,
  };
  const deps = {
    lifecycle: {
      submitKyc: async () => ({ kycStatus: "Initiated" }),
      kycStatus: async () => ({ status: f.kyc, customerId: "cust-1", kycToken: "kt" }),
      cardBalance: async () => 0,
      simulateAuthorization: async (a: { cardId: string; amountDollars: number; merchantName?: string; mid?: string }) => {
        f.authCalls++;
        if (f.authorize === "decline") throw new MidenApiError("POST", "/api/v1/mock/authorization", 400, JSON.stringify({ responseCode: "51", responseMessage: "Insufficient funds" }));
        if (f.authorize === "hang") {
          if (f.chargedOnHang) f.txns.push({ cardId: a.cardId, transactionType: "Authorization", transactionStatus: "Approved", transactionAmount: a.amountDollars, merchantName: a.merchantName, merchantMid: a.mid, authCode: "hung1" });
          throw new Error("socket hang up");
        }
        return `auth-${f.authCalls}`;
      },
      transactions: async (cardId: string, type?: string) => f.txns.filter((t) => t.cardId === cardId && (!type || t.transactionType === type)),
    },
    cardIssuer: { issue: async (_a: string, policy: unknown) => ({ id: `card-${++f.cardsIssued}`, agentId: "x", policy }) },
    funding: {
      fund: async (req: FundingRequest) => {
        f.fundCalls.push(req);
        const mode = f.fund.shift() ?? "ok";
        if (mode === "timeout" || mode === "duplicate") {
          // Both mean the top-up may have landed; record it on the card as Miden does (clientReference -> transactionReference).
          if (!f.txns.some((t) => t.transactionReference === req.idempotencyKey)) f.txns.push({ cardId: req.cardId, transactionType: "CardFunding", transactionStatus: "Approved", transactionReference: req.idempotencyKey });
        }
        if (mode === "timeout") throw new Error("ETIMEDOUT");
        if (mode === "duplicate") throw new MidenDuplicateReferenceError(req.idempotencyKey, new MidenApiError("PATCH", "/", 400, "already been seen"));
        if (mode === "reject") throw new MidenApiError("PATCH", "/api/v1/cards/topup", 400, JSON.stringify({ responseCode: "117", responseMessage: "Insufficient wallet balance" }));
        return { id: "m1", status: "confirmed" as const };
      },
    },
  };
  return { f, deps };
}

async function setup() {
  const schema = `t_${randomBytes(6).toString("hex")}`;
  await admin!.query(`CREATE SCHEMA ${schema}`);
  schemas.push(schema);
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 6 });
  pools.push(pool);
  await migrate(pool);
  const db = createDatabase(pool);
  const repos = createRepositories(db);
  const store = repos.ledger;
  const ledger = new Ledger(undefined, store);
  const { f, deps } = fakeMiden();
  const make = (over: Partial<CardholderContext> = {}) => {
    const d = {
      users: repos.users, cards: repos.cards, agents: repos.agents, spends: repos.spends, fundings: repos.fundings, oneTimeCards: repos.oneTimeCards,
      ledger, wallets: new AgentWallets(ledger), addresses: createDepositAddressRepository(db, "base-sepolia"),
      deriveAddress: (i: number) => `0x${i.toString(16).padStart(40, "0")}`, tiers: DEFAULT_TIERS, chain: "base-sepolia", sandbox: true, simulatedDeposits: true,
      ...deps,
      ...over,
    } as unknown as CardholderContext;
    return new CardholderInteractor(d);
  };
  const app = make();
  const { userId, token } = await app.signup(`u${randomBytes(3).toString("hex")}@example.com`);
  await app.submitKyc(userId, KYC);
  return { app, make, f, pool, ledger, userId, token };
}

async function withMoney(s: Awaited<ReturnType<typeof setup>>, cents = 2_000) {
  await s.app.simulateDeposit(s.userId, cents);
  await s.app.fundPending();
}

test("KYC approval issues one card with a deposit address; repeat refreshes change nothing", { skip }, async () => {
  const s = await setup();
  await s.app.refresh(s.userId);
  await Promise.all([s.app.refresh(s.userId), s.app.refresh(s.userId)]);
  const o = await s.app.overview(s.userId);
  assert.equal(s.f.cardsIssued, 1);
  assert.equal(o.card?.deposit.address, `0x${"0".repeat(40)}`);
  assert.equal(o.card?.limits.perTransactionCents, DEFAULT_TIERS.quick.perTransactionCents);
});

test("no card until KYC is approved", { skip }, async () => {
  const s = await setup();
  const t = await s.app.signup("pending@example.com");
  s.f.kyc = "Pending";
  await s.app.submitKyc(t.userId, KYC);
  assert.equal((await s.app.overview(t.userId)).card, null);
  await assert.rejects(s.app.createAgent(t.userId, { name: "a", perTransactionCents: 1, dailyCents: 1 }), /complete KYC first/);
});

test("deposit -> funded card; a timed-out top-up is retried with the same id and lands once", { skip }, async () => {
  const s = await setup();
  s.f.fund.push("timeout", "duplicate");
  await s.app.simulateDeposit(s.userId, 2_000);
  await s.app.fundPending(); // times out: stays reserved
  const card = (await s.app.overview(s.userId)).card!;
  assert.equal(card.balances.fundingInFlightCents, 2_000);
  await s.app.fundPending(); // retry: Miden says "already seen" -> it landed
  const after = (await s.app.overview(s.userId)).card!;
  assert.equal(after.balances.unallocatedOnCardCents, 2_000);
  assert.equal(after.balances.fundingInFlightCents, 0);
  assert.equal(s.f.fundCalls.length, 2);
  assert.equal(s.f.fundCalls[0]!.idempotencyKey, s.f.fundCalls[1]!.idempotencyKey);
});

test("a rejected top-up returns the money to holding and is retried later as a new funding", { skip }, async () => {
  const s = await setup();
  s.f.fund.push("reject");
  await withMoney(s);
  let card = (await s.app.overview(s.userId)).card!;
  assert.equal(card.balances.awaitingFundingCents, 2_000);
  assert.equal(card.fundings[0]!.status, "released");
  await s.app.fundPending();
  card = (await s.app.overview(s.userId)).card!;
  assert.equal(card.balances.unallocatedOnCardCents, 2_000);
});

test("funding stops at the tier's lifetime cap; the rest waits in holding", { skip }, async () => {
  const s = await setup();
  const cap = DEFAULT_TIERS.quick.lifetimeFundedCents;
  await s.app.simulateDeposit(s.userId, 100_000);
  await s.app.fundPending();
  const card = (await s.app.overview(s.userId)).card!;
  assert.equal(card.balances.unallocatedOnCardCents, cap);
  assert.equal(card.balances.awaitingFundingCents, 100_000 - cap);
});

test("agent limits must fit the card; tokens are per agent and die on revoke", { skip }, async () => {
  const s = await setup();
  await withMoney(s);
  const q = DEFAULT_TIERS.quick;
  await assert.rejects(s.app.createAgent(s.userId, { name: "bot", perTransactionCents: q.perTransactionCents + 1, dailyCents: q.dailyCents }), /per-payment limit can be at most/);
  await assert.rejects(s.app.createAgent(s.userId, { name: "bot", perTransactionCents: 100, dailyCents: q.dailyCents + 1 }), /daily limit can be at most/);
  await assert.rejects(s.app.createAgent(s.userId, { name: "bot", perTransactionCents: 800, dailyCents: 500 }), /cannot be more than the daily/);
  const a = await s.app.createAgent(s.userId, { name: "bot", perTransactionCents: q.perTransactionCents, dailyCents: q.dailyCents });
  assert.equal(a.policy.perTransactionCents, q.perTransactionCents);
  await assert.rejects(s.app.updateAgentLimits(s.userId, a.agentId, { dailyCents: q.dailyCents + 1 }), /daily limit can be at most/);
  await s.app.fundAgent(s.userId, a.agentId, 500);
  const p = await s.app.agentByToken(a.token);
  assert.equal(p?.agentId, a.agentId);
  assert.equal(await s.app.agentByToken(a.token + "x"), undefined);
  await s.app.revokeAgent(s.userId, a.agentId);
  assert.equal(await s.app.agentByToken(a.token), undefined);
  assert.equal((await s.app.overview(s.userId)).card!.balances.unallocatedOnCardCents, 2_000);
});

test("pay: approved, idempotent, and a card decline puts the money and the daily allowance back", { skip }, async () => {
  const s = await setup();
  await withMoney(s);
  const a = await s.app.createAgent(s.userId, { name: "bot", perTransactionCents: 1_000, dailyCents: 1_500 });
  await s.app.fundAgent(s.userId, a.agentId, 2_000);
  const p = (await s.app.agentByToken(a.token))!;

  const ok = await s.app.pay(p, { amountCents: 1_000, merchant: "M", idempotencyKey: "k1" });
  assert.equal(ok.status, "approved");
  const [r1, r2] = await Promise.all([
    s.app.pay(p, { amountCents: 1_000, merchant: "M", idempotencyKey: "k1" }),
    s.app.pay(p, { amountCents: 1_000, merchant: "M", idempotencyKey: "k1" }),
  ]);
  assert.equal(r1.spendId, ok.spendId);
  assert.equal(r2.spendId, ok.spendId);
  assert.equal(s.f.authCalls, 1);
  await assert.rejects(s.app.pay(p, { amountCents: 999, merchant: "M", idempotencyKey: "k1" }), /different payment/);

  s.f.authorize = "decline";
  const no = await s.app.pay(p, { amountCents: 500, merchant: "M", idempotencyKey: "k2" });
  assert.equal(no.status, "voided");
  assert.match(no.reason!, /Insufficient funds/);
  assert.equal((await s.app.agentWallet(p)).balanceCents, 1_000);

  s.f.authorize = "approve";
  // The voided $5 did not use up the daily allowance: $10 + $5 = $15 is still allowed.
  assert.equal((await s.app.pay(p, { amountCents: 500, merchant: "M", idempotencyKey: "k3" })).status, "approved");
  assert.equal((await s.app.pay(p, { amountCents: 1, merchant: "M", idempotencyKey: "k4" })).status, "declined");
  assert.equal(await s.ledger.balance(accounts.agent(p.cardId, p.agentId)), 500);
});

const later = (ms: number) => () => new Date(Date.now() + ms);

test("restart: daily totals are restored; an interrupted payment stays held until the card's record settles it", { skip }, async () => {
  const s = await setup();
  await withMoney(s);
  const a = await s.app.createAgent(s.userId, { name: "bot", perTransactionCents: 1_000, dailyCents: 1_200 });
  await s.app.fundAgent(s.userId, a.agentId, 2_000);
  const p = (await s.app.agentByToken(a.token))!;
  await s.app.pay(p, { amountCents: 1_000, merchant: "M", idempotencyKey: "k1" });
  // A crash mid-payment: the agent was debited, the seq was never saved on the row, and the card has no record.
  await s.ledger.recordAgentSpend({ cardId: p.cardId, agentId: p.agentId, amountCents: 200, spendId: "sp_crash" });
  await s.pool.query(
    "INSERT INTO app_spend (spend_id, card_id, agent_id, idempotency_key, amount_cents, merchant, status) VALUES ('sp_crash', $1, $2, 'kc', 200, 'M', 'processing')",
    [p.cardId, p.agentId],
  );
  const status = async (app: CardholderInteractor) => (await app.agentTransactions(p)).find((t) => t.spendId === "sp_crash")!.status;

  const fresh = s.make();
  await fresh.restore();
  assert.equal(await status(fresh), "processing");
  assert.equal((await fresh.agentWallet(p)).balanceCents, 800);
  // $10 approved + $2 held = the whole $12 day.
  assert.equal((await fresh.pay(p, { amountCents: 100, merchant: "M", idempotencyKey: "k5" })).status, "declined");

  await s.make({ now: later(2 * 60_000) }).reconcileSpends();
  assert.equal(await status(fresh), "processing", "no card record yet, too early to give up");
  const afterTen = s.make({ now: later(11 * 60_000) });
  await afterTen.restore();
  await afterTen.reconcileSpends();
  // Absence from the card's list is not proof it was not charged: held and flagged, never refunded automatically.
  const flagged = (await fresh.agentTransactions(p)).find((t) => t.spendId === "sp_crash")!;
  assert.equal(flagged.status, "processing");
  assert.match(flagged.reason!, /needs review/);
  assert.equal((await fresh.agentWallet(p)).balanceCents, 800);
});

test("lost card answer: the payment stays processing, is never re-sent, and settles from the card's record", { skip }, async () => {
  const s = await setup();
  await withMoney(s);
  const a = await s.app.createAgent(s.userId, { name: "bot", perTransactionCents: 1_000, dailyCents: 1_500 });
  await s.app.fundAgent(s.userId, a.agentId, 2_000);
  const p = (await s.app.agentByToken(a.token))!;

  s.f.authorize = "hang"; // charged on the card, answer lost
  const charged = await s.app.pay(p, { amountCents: 700, merchant: "M", idempotencyKey: "h1" });
  assert.equal(charged.status, "processing");
  assert.equal((await s.app.agentWallet(p)).balanceCents, 1_300);
  assert.equal((await s.app.pay(p, { amountCents: 700, merchant: "M", idempotencyKey: "h1" })).status, "processing");
  // Held money counts against today: $7 + $9 > $15.
  s.f.authorize = "approve";
  assert.equal((await s.app.pay(p, { amountCents: 900, merchant: "M", idempotencyKey: "h2" })).status, "declined");

  s.f.authorize = "hang";
  s.f.chargedOnHang = false; // never reached the card
  const lost = await s.app.pay(p, { amountCents: 300, merchant: "M", idempotencyKey: "h3" });
  assert.equal(lost.status, "processing");
  const calls = s.f.authCalls;

  await s.make({ now: later(2 * 60_000) }).reconcileSpends();
  const view = async (id: string) => (await s.app.agentTransactions(p)).find((t) => t.spendId === id)!;
  assert.equal((await view(charged.spendId)).status, "approved");
  assert.equal((await view(lost.spendId)).status, "processing");
  await s.app.reconcileSpends(); // too young: untouched
  const late = s.make({ now: later(11 * 60_000) });
  await late.restore();
  await late.reconcileSpends();
  assert.equal((await view(lost.spendId)).status, "processing");
  assert.match((await view(lost.spendId)).reason!, /needs review/);
  assert.equal(s.f.authCalls, calls, "reconcile never re-sends a payment");
  assert.equal(await s.ledger.balance(accounts.agent(p.cardId, p.agentId)), 1_000, "both lost payments stay held");

  // The card later shows it declined: only then is the money returned.
  s.f.txns.push({ cardId: p.cardId, transactionType: "Authorization", transactionStatus: "Declined", merchantMid: midFor(lost.spendId) });
  await late.reconcileSpends();
  assert.equal((await view(lost.spendId)).status, "voided");
  assert.equal(await s.ledger.balance(accounts.agent(p.cardId, p.agentId)), 1_300);
});

test("a reconcile that closes a slow payment's row first makes the payment undo its debit and skip the card", { skip }, async () => {
  const s = await setup();
  await withMoney(s);
  const a = await s.app.createAgent(s.userId, { name: "bot", perTransactionCents: 1_000, dailyCents: 1_500 });
  await s.app.fundAgent(s.userId, a.agentId, 2_000);
  const p = (await s.app.agentByToken(a.token))!;
  const other = s.make({ now: later(2 * 60_000) }); // another process, its clock past the reconcile threshold
  const wallets = new AgentWallets(s.ledger);
  const realSpend = wallets.spend.bind(wallets);
  wallets.spend = async (...args: Parameters<AgentWallets["spend"]>) => {
    await other.reconcileSpends(); // runs while this payment's debit is "slow"
    return realSpend(...args);
  };
  const slow = s.make({ wallets });
  await slow.restore();
  const calls = s.f.authCalls;
  const r = await slow.pay(p, { amountCents: 400, merchant: "M", idempotencyKey: "slow1" });
  assert.equal(r.status, "voided");
  assert.equal(s.f.authCalls, calls, "the card was never charged");
  assert.equal(await s.ledger.balance(accounts.agent(p.cardId, p.agentId)), 2_000);
});

test("the card's daily limit is shared by all its agents", { skip }, async () => {
  const s = await setup();
  await withMoney(s, 30_000);
  const q = DEFAULT_TIERS.quick;
  const mk = async (name: string) => {
    const a = await s.app.createAgent(s.userId, { name, perTransactionCents: q.perTransactionCents, dailyCents: q.dailyCents });
    await s.app.fundAgent(s.userId, a.agentId, q.dailyCents);
    return (await s.app.agentByToken(a.token))!;
  };
  const [x, y] = [await mk("x"), await mk("y")];
  const first = q.dailyCents - q.perTransactionCents / 2;
  let left = first;
  for (let i = 0; left > 0; i++) {
    const amt = Math.min(left, q.perTransactionCents);
    assert.equal((await s.app.pay(x, { amountCents: amt, merchant: "M", idempotencyKey: `x${i}` })).status, "approved");
    left -= amt;
  }
  const over = await s.app.pay(y, { amountCents: q.perTransactionCents, merchant: "M", idempotencyKey: "y1" });
  assert.equal(over.status, "declined");
  assert.match(over.reason!, /card daily limit/);
  assert.equal((await s.app.pay(y, { amountCents: q.perTransactionCents / 2, merchant: "M", idempotencyKey: "y2" })).status, "approved");
});

test("a top-up Miden has 'already seen' is completed only if the card shows it", { skip }, async () => {
  const s = await setup();
  s.f.fund.push("duplicate");
  await s.app.simulateDeposit(s.userId, 2_000);
  await s.app.fundPending();
  // The fake records duplicates on the card; drop that record to model "seen, but did not land".
  const s2 = await setup();
  s2.f.fund.push("duplicate");
  await s2.app.simulateDeposit(s2.userId, 2_000);
  s2.f.txns.length = 0;
  const orig = s2.f.txns.push.bind(s2.f.txns);
  s2.f.txns.push = () => 0; // nothing reaches the card
  await s2.app.fundPending();
  s2.f.txns.push = orig;
  assert.equal((await s.app.overview(s.userId)).card!.balances.unallocatedOnCardCents, 2_000);
  const stuck = (await s2.app.overview(s2.userId)).card!;
  assert.equal(stuck.balances.fundingInFlightCents, 2_000, "left reserved for review, not assumed landed");
  assert.equal(stuck.balances.unallocatedOnCardCents, 0);
});

test("money waiting in holding says why", { skip }, async () => {
  const s = await setup();
  await s.app.simulateDeposit(s.userId, 50);
  await s.app.fundPending();
  assert.match((await s.app.overview(s.userId)).card!.balances.awaitingFundingReason!, /minimum top-up/);
  await s.app.simulateDeposit(s.userId, DEFAULT_TIERS.quick.lifetimeFundedCents + 1_000);
  await s.app.fundPending();
  assert.match((await s.app.overview(s.userId)).card!.balances.awaitingFundingReason!, /lifetime funding limit/);
});

test("HTTP: Host guard, token checks, and MCP needs an agent token", { skip }, async () => {
  const s = await setup();
  const server = createAppServer({ cardholders: s.app }, { allowedHosts: [] });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  server.close();
  const real = createAppServer({ cardholders: s.app }, { allowedHosts: [`127.0.0.1:${port}`] });
  await new Promise<void>((r) => real.listen(port, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${port}`;
    const get = (path: string, headers: Record<string, string> = {}) => fetch(url + path, { headers });
    // fetch() will not send a custom Host header; use http.request.
    const rebound = await new Promise<number>((resolve, reject) => {
      request({ host: "127.0.0.1", port, path: "/healthz", headers: { host: "evil.example" } }, (r) => { r.resume(); resolve(r.statusCode!); }).on("error", reject).end();
    });
    assert.equal(rebound, 421);
    assert.equal((await get("/healthz")).status, 200);
    assert.equal((await get("/api/me")).status, 401);
    assert.equal((await get("/api/me", { authorization: `Bearer ${s.token}` })).status, 200);
    // A user token is not an agent token, and vice versa.
    assert.equal((await get("/agent/v1/wallet", { authorization: `Bearer ${s.token}` })).status, 401);
    const mcp = await fetch(`${url}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(mcp.status, 401);
    // Cross-site: a text/plain POST (no preflight) and a foreign Origin are both refused.
    assert.equal((await fetch(`${url}/api/signup`, { method: "POST", headers: { "content-type": "text/plain" }, body: '{"email":"x@example.com"}' })).status, 415);
    assert.equal((await fetch(`${url}/api/signup`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: '{"email":"x@example.com"}' })).status, 403);
    assert.equal((await fetch(`${url}/api/signup`, { method: "POST", headers: { "content-type": "application/json", origin: url }, body: `{"email":"o${Date.now()}@example.com"}` })).status, 201);
    // The old user token stops working once replaced.
    const rotated = await fetch(`${url}/api/me/token`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${s.token}` }, body: "{}" });
    const { token: next } = (await rotated.json()) as { token: string };
    assert.equal((await get("/api/me", { authorization: `Bearer ${s.token}` })).status, 401);
    assert.equal((await get("/api/me", { authorization: `Bearer ${next}` })).status, 200);
  } finally {
    real.close();
  }
});

test("sim_ chain deposit credits the caller's own deposit address once; another user's address is refused", { skip }, async () => {
  const s = await setup();
  await s.app.refresh(s.userId);
  const address = (await s.app.overview(s.userId)).card!.deposit.address;
  const id = `sim_${address}_USDC_12.34`;
  assert.deepEqual(await s.app.simulateChainDeposit(s.userId, id), { amountCents: 1_234 });
  await s.app.simulateChainDeposit(s.userId, id);
  assert.equal((await s.app.overview(s.userId)).card?.deposit.address, address);
  const rows = await s.pool.query("SELECT count(*)::int AS n FROM ledger_tx WHERE idempotency_key LIKE 'deposit:sandbox-sim:sim\\_%'");
  assert.equal(rows.rows[0].n, 1);
  await assert.rejects(s.app.simulateChainDeposit(s.userId, `sim_0x${"9".repeat(40)}_USDC_5`), /not one of your deposit addresses/);
  await assert.rejects(s.app.simulateChainDeposit(s.userId, `sim_${address}_USDC_1001`), /capped/);
  await assert.rejects(s.app.simulateChainDeposit(s.userId, "garbage"), /id must look like/);
  await assert.rejects(s.make({ simulatedDeposits: false }).simulateChainDeposit(s.userId, id), /switched off/);
});
