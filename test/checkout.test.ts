import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { AgentWallets } from "../src/lib/services/AgentWallets.js";
import { createDepositAddressRepository } from "../src/db/repositories/createChainRepositories.js";
import { DEFAULT_TIERS } from "../src/lib/services/tiers.js";
import { Ledger, accounts } from "../src/lib/services/Ledger.js";
import { createDatabase } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createRepositories } from "../src/db/repositories/createRepositories.js";
import { MidenApiError } from "../src/lib/clients/cardIssuing/miden/MidenClient.js";
import { CheckoutInteractor } from "../src/lib/interactors/CheckoutInteractor.js";
import { MAX_SIGN_FAILURES, PayoutInteractor } from "../src/lib/interactors/PayoutInteractor.js";
import type { SignedTransfer, TransferState } from "../src/adapters/payouts/UsdcPayoutRail.js";
import { createAppServer } from "../src/createHttpServer.js";
import { CardholderInteractor, type CardholderContext } from "../src/lib/interactors/CardholderInteractor.js";
import { AgentCardsAgent, AgentCardsCheckout, AgentCardsError, checkoutButton, parseCheckoutId } from "../sdk/checkout/src/index.js";

// Runs only with DATABASE_URL (each case gets its own schema). Miden is faked, as in app.test.ts.
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

function fakeMiden() {
  const f = {
    authorize: "approve" as "approve" | "decline" | "hang",
    authCalls: [] as { amountDollars: number; merchantName?: string; mcc?: string }[],
    txns: [] as Record<string, unknown>[],
  };
  const deps = {
    lifecycle: {
      submitKyc: async () => ({ kycStatus: "Initiated" }),
      kycStatus: async () => ({ status: "Approved", customerId: "cust-1", kycToken: "kt" }),
      cardBalance: async () => 0,
      simulateAuthorization: async (a: { cardId: string; amountDollars: number; merchantName?: string; mcc?: string; mid?: string }) => {
        f.authCalls.push(a);
        if (f.authorize === "decline") throw new MidenApiError("POST", "/api/v1/mock/authorization", 400, JSON.stringify({ responseCode: "51", responseMessage: "Insufficient funds" }));
        if (f.authorize === "hang") {
          f.txns.push({ cardId: a.cardId, transactionType: "Authorization", transactionStatus: "Approved", merchantMid: a.mid, authCode: "hung" });
          throw new Error("socket hang up");
        }
        return `auth-${f.authCalls.length}`;
      },
      transactions: async (cardId: string, type?: string) => f.txns.filter((t) => t.cardId === cardId && (!type || t.transactionType === type)),
    },
    cardIssuer: { issue: async (_a: string, policy: unknown) => ({ id: `card-${randomBytes(3).toString("hex")}`, agentId: "x", policy }) },
    funding: { fund: async () => ({ id: "m1", status: "confirmed" as const }) },
  };
  return { f, deps };
}

const later = (ms: number) => () => new Date(Date.now() + ms);
const WALLET = "0x1111111111111111111111111111111111111111";

async function setup() {
  const schema = `t_${randomBytes(6).toString("hex")}`;
  await admin!.query(`CREATE SCHEMA ${schema}`);
  schemas.push(schema);
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 6 });
  pools.push(pool);
  await migrate(pool);
  const db = createDatabase(pool);
  const repos = createRepositories(db);
  const ledger = new Ledger(undefined, repos.ledger);
  const { f, deps } = fakeMiden();
  const make = (over: Partial<CardholderContext> = {}) => new CardholderInteractor({
    users: repos.users, cards: repos.cards, agents: repos.agents, spends: repos.spends, fundings: repos.fundings, oneTimeCards: repos.oneTimeCards,
    ledger, wallets: new AgentWallets(ledger), addresses: createDepositAddressRepository(db, "base-sepolia"),
    deriveAddress: (i: number) => `0x${i.toString(16).padStart(40, "0")}`, tiers: DEFAULT_TIERS, chain: "base-sepolia", sandbox: true, simulatedDeposits: true,
    ...deps, ...over,
  } as unknown as CardholderContext);
  const app = make();
  const OWN = "0x00000000000000000000000000000000000000aa";
  const checkoutFor = (a: CardholderInteractor, now?: () => Date, payoutAddressDelayMs = 0) =>
    new CheckoutInteractor({ merchants: repos.merchants, checkouts: repos.checkouts, payouts: repos.payouts, ledger, app: a, publicUrl: "http://127.0.0.1:8787", now, payoutAddressDelayMs, isOwnAddress: async (x) => x === OWN });
  const checkout = checkoutFor(app);
  const { userId } = await app.signup(`u${randomBytes(3).toString("hex")}@example.com`);
  await app.submitKyc(userId, KYC);
  await app.simulateDeposit(userId, 5_000);
  await app.fundPending();
  const agent = async (name = "bot", limits: { perTransactionCents?: number; dailyCents?: number; allowedMccs?: string[] } = {}, fund = 2_000) => {
    const a = await app.createAgent(userId, { name, perTransactionCents: 1_500, dailyCents: 3_000, ...limits });
    if (fund) await app.fundAgent(userId, a.agentId, fund);
    return { ...a, p: (await app.agentByToken(a.token))! };
  };
  const merchant = await checkout.createMerchant({ name: "Acme API", email: `m${randomBytes(3).toString("hex")}@example.com`, mcc: "5734" });
  return { app, make, checkoutFor, checkout, f, pool, db, repos, ledger, userId, agent, merchant, OWN };
}

test("checkout: an agent pays the merchant's price once; retries return the same payment", { skip }, async () => {
  const s = await setup();
  const { p, agentId } = await s.agent();
  const c = await s.checkout.create(s.merchant.merchantId, { amountCents: 1_250, description: "1M tokens", reference: "order-1", metadata: { sku: "t1m" } });
  assert.equal(c.status, "open");
  assert.match(c.checkoutUrl, /\/pay\/cs_[a-f0-9]{32}$/);

  const pub = await s.checkout.getPublic(c.checkoutId);
  assert.deepEqual(Object.keys(pub).sort(), ["amountCents", "checkoutId", "currency", "description", "expiresAt", "merchant", "status"], "no metadata or reference leaks to agents");
  assert.equal(pub.merchant, "Acme API");

  const [r1, r2] = await Promise.all([s.checkout.pay(p, c.checkoutId), s.checkout.pay(p, c.checkoutId)]);
  assert.equal(r1.payment.status, "approved");
  assert.equal(r1.checkout.status, "paid");
  assert.equal(r2.payment.spendId, r1.payment.spendId);
  assert.equal(s.f.authCalls.length, 1, "the card is charged once");
  assert.deepEqual({ ...s.f.authCalls[0], mid: undefined, cardId: undefined }, { amountDollars: 12.5, merchantName: "Acme API", mcc: "5734", mid: undefined, cardId: undefined });
  assert.equal((await s.checkout.pay(p, c.checkoutId)).payment.spendId, r1.payment.spendId);
  assert.equal(await s.ledger.balance(accounts.agent(p.cardId, agentId)), 750);

  const m = await s.checkout.getForMerchant(s.merchant.merchantId, c.checkoutId);
  assert.equal(m.status, "paid");
  assert.deepEqual(m.payment, { paymentId: r1.payment.spendId, status: "approved" });
  assert.deepEqual(m.metadata, { sku: "t1m" });
  assert.ok(m.paidAt);

  const other = await s.agent("other");
  await assert.rejects(s.checkout.pay(other.p, c.checkoutId), /already paid/);
  await assert.rejects(s.checkout.cancel(s.merchant.merchantId, c.checkoutId), /paid and cannot be canceled/);
});

test("checkout: an agent cannot pre-spend 1 cent under the checkout's key to mark it paid", { skip }, async () => {
  const s = await setup();
  const { p } = await s.agent();
  const c = await s.checkout.create(s.merchant.merchantId, { amountCents: 1_000, description: "the real price" });
  await assert.rejects(
    s.app.pay(p, { amountCents: 1, merchant: "Acme API", mcc: "5734", idempotencyKey: `checkout:${c.checkoutId}:1` }),
    (e: { status?: number }) => e.status === 400,
  );
  assert.equal(s.f.authCalls.length, 0);
  // Defence in depth: even if such a spend existed, it cannot pay the checkout.
  await s.pool.query(
    "INSERT INTO app_spend (spend_id, card_id, agent_id, idempotency_key, amount_cents, merchant, status) VALUES ('sp_cheat', $1, $2, $3, 1, 'Acme API', 'approved')",
    [p.cardId, p.agentId, `checkout:${c.checkoutId}:1`],
  );
  await assert.rejects(s.checkout.pay(p, c.checkoutId), /different payment/);
  const m = await s.checkout.getForMerchant(s.merchant.merchantId, c.checkoutId);
  assert.notEqual(m.status, "paid");
  assert.ok(m.underReview);
});

test("checkout: maxAmountCents refuses a dearer checkout without charging", { skip }, async () => {
  const s = await setup();
  const { p } = await s.agent();
  const c = await s.checkout.create(s.merchant.merchantId, { amountCents: 900, description: "x" });
  await assert.rejects(s.checkout.pay(p, c.checkoutId, { maxAmountCents: 899 }), /more than the 899/);
  assert.equal((await s.checkout.getPublic(c.checkoutId)).status, "open");
  assert.equal((await s.checkout.pay(p, c.checkoutId, { maxAmountCents: 900 })).checkout.status, "paid");
});

test("checkout: a failed attempt shows the merchant only lastAttempt = failed, never the payer's reasons", { skip }, async () => {
  const s = await setup();
  const { p } = await s.agent("poor", {}, 100);
  const c = await s.checkout.create(s.merchant.merchantId, { amountCents: 500, description: "x" });
  await s.checkout.pay(p, c.checkoutId);
  const m = await s.checkout.getForMerchant(s.merchant.merchantId, c.checkoutId);
  assert.equal(m.lastAttempt, "failed");
  assert.doesNotMatch(JSON.stringify(m), /insufficient|limit/i);
});

test("checkout: two agents race; exactly one pays", { skip }, async () => {
  const s = await setup();
  const [x, y] = [await s.agent("x"), await s.agent("y")];
  const c = await s.checkout.create(s.merchant.merchantId, { amountCents: 500, description: "race" });
  const results = await Promise.allSettled([
    s.checkout.pay(x.p, c.checkoutId),
    s.checkoutFor(s.make()).pay(y.p, c.checkoutId), // another process
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.match(String((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason), /another agent is paying|already paid/);
  assert.equal(s.f.authCalls.length, 1);
});

test("checkout: a declined payment leaves it open; the agent can pay after a top-up, under a new attempt", { skip }, async () => {
  const s = await setup();
  const { p, agentId } = await s.agent("bot", {}, 300);
  const c = await s.checkout.create(s.merchant.merchantId, { amountCents: 800, description: "too dear" });
  const no = await s.checkout.pay(p, c.checkoutId);
  assert.equal(no.payment.status, "declined");
  assert.equal(no.checkout.status, "open");
  assert.equal(s.f.authCalls.length, 0, "our limits refused it before the card");

  s.f.authorize = "decline";
  await s.app.fundAgent(s.userId, agentId, 1_000);
  const voided = await s.checkout.pay(p, c.checkoutId);
  assert.equal(voided.payment.status, "voided");
  assert.equal(voided.checkout.status, "open");
  assert.equal(await s.ledger.balance(accounts.agent(p.cardId, agentId)), 1_300, "card decline put the money back");

  s.f.authorize = "approve";
  const ok = await s.checkout.pay(p, c.checkoutId);
  assert.equal(ok.payment.status, "approved");
  assert.equal(ok.checkout.status, "paid");
  assert.notEqual(ok.payment.spendId, voided.payment.spendId);
});

test("checkout: the agent's MCC allowlist and per-payment limit apply", { skip }, async () => {
  const s = await setup();
  const { p } = await s.agent("picky", { allowedMccs: ["5812"] });
  const c = await s.checkout.create(s.merchant.merchantId, { amountCents: 100, description: "software" });
  const r = await s.checkout.pay(p, c.checkoutId);
  assert.equal(r.payment.status, "declined");
  assert.match(r.payment.reason!, /mcc|category/i);
  const food = await s.checkout.create(s.merchant.merchantId, { amountCents: 100, description: "lunch", mcc: "5812" });
  assert.equal((await s.checkout.pay(p, food.checkoutId)).payment.status, "approved");
  const big = await s.checkout.create(s.merchant.merchantId, { amountCents: 1_600, description: "big", mcc: "5812" });
  assert.equal((await s.checkout.pay(p, big.checkoutId)).payment.status, "declined");
});

test("checkout: a lost card answer keeps it processing; it becomes paid when the payment settles", { skip }, async () => {
  const s = await setup();
  const { p } = await s.agent();
  const c = await s.checkout.create(s.merchant.merchantId, { amountCents: 700, description: "slow network" });
  s.f.authorize = "hang";
  const r = await s.checkout.pay(p, c.checkoutId);
  assert.equal(r.payment.status, "processing");
  assert.equal(r.checkout.status, "processing");
  s.f.authorize = "approve";
  assert.equal((await s.checkout.pay(p, c.checkoutId)).payment.spendId, r.payment.spendId, "a retry resumes, never re-charges");
  assert.equal(s.f.authCalls.length, 1);
  await assert.rejects(s.checkout.cancel(s.merchant.merchantId, c.checkoutId), /processing/);

  await s.make({ now: later(2 * 60_000) }).reconcileSpends();
  await s.checkout.sync();
  const m = await s.checkout.getForMerchant(s.merchant.merchantId, c.checkoutId);
  assert.equal(m.status, "paid");
  assert.equal(m.payment?.status, "approved");
});

test("checkout: a crash between claim and payment is released after a while; nothing was charged", { skip }, async () => {
  const s = await setup();
  const { p } = await s.agent();
  const c = await s.checkout.create(s.merchant.merchantId, { amountCents: 400, description: "crash" });
  await s.pool.query("UPDATE app_checkout SET status = 'processing', card_id = $2, agent_id = $3, attempt = 1, claimed_at = now() WHERE checkout_id = $1", [c.checkoutId, p.cardId, p.agentId]);
  await s.checkout.sync();
  assert.equal((await s.checkout.getPublic(c.checkoutId)).status, "processing", "too early to call it stale");
  await s.checkoutFor(s.app, later(11 * 60_000)).sync();
  assert.equal((await s.checkout.getPublic(c.checkoutId)).status, "open");
  const other = await s.agent("other");
  assert.equal((await s.checkout.pay(other.p, c.checkoutId)).checkout.status, "paid");
});

test("checkout: cancel, expiry, merchant idempotency and isolation", { skip }, async () => {
  const s = await setup();
  const { p } = await s.agent();
  const mid = s.merchant.merchantId;
  const a = await s.checkout.create(mid, { amountCents: 100, description: "x", idempotencyKey: "k1" });
  assert.equal((await s.checkout.create(mid, { amountCents: 100, description: "x", idempotencyKey: "k1" })).checkoutId, a.checkoutId);
  await assert.rejects(s.checkout.create(mid, { amountCents: 101, description: "x", idempotencyKey: "k1" }), /different checkout/);

  assert.equal((await s.checkout.cancel(mid, a.checkoutId)).status, "canceled");
  await assert.rejects(s.checkout.pay(p, a.checkoutId), /canceled/);

  const e = await s.checkout.create(mid, { amountCents: 100, description: "short", expiresInSeconds: 60 });
  await assert.rejects(s.checkoutFor(s.app, later(61_000)).pay(p, e.checkoutId), /expired/);
  assert.equal((await s.checkout.getForMerchant(mid, e.checkoutId)).status, "expired");

  const rival = await s.checkout.createMerchant({ name: "Rival", email: `r${randomBytes(3).toString("hex")}@example.com` });
  await assert.rejects(s.checkout.getForMerchant(rival.merchantId, e.checkoutId), /not found/);
  await assert.rejects(s.checkout.cancel(rival.merchantId, e.checkoutId), /not found/);
  assert.equal((await s.checkout.list(rival.merchantId)).length, 0);

  for (const bad of [{ amountCents: 0, description: "x" }, { amountCents: 1.5, description: "x" }, { amountCents: 1, description: "" }, { amountCents: 1, description: "x", mcc: "12" }, { amountCents: 1, description: "x", expiresInSeconds: 5 }, { amountCents: 1, description: "x", metadata: { big: "y".repeat(5000) } }]) {
    await assert.rejects(s.checkout.create(mid, bad), (err: { status?: number }) => err.status === 400);
  }
});

test("settlement: a paid checkout credits the merchant once; a crash before crediting is healed by sync", { skip }, async () => {
  const s = await setup();
  const { p } = await s.agent();
  const mid = s.merchant.merchantId;
  const c = await s.checkout.create(mid, { amountCents: 1_250, description: "x" });
  await Promise.all([s.checkout.pay(p, c.checkoutId), s.checkout.pay(p, c.checkoutId)]);
  await s.checkout.pay(p, c.checkoutId);
  assert.deepEqual(await s.checkout.balance(mid), { availableCents: 1_250, pendingPayoutCents: 0, currency: "USD" });

  // Crash between paid and the credit: sync credits it, and only once even if the credit had in fact landed.
  const d = await s.checkout.create(mid, { amountCents: 300, description: "y" });
  await s.checkout.pay(p, d.checkoutId);
  await s.pool.query("UPDATE app_checkout SET settled_seq = NULL WHERE checkout_id = ANY($1)", [[c.checkoutId, d.checkoutId]]);
  await s.checkout.sync();
  await s.checkout.sync();
  assert.equal((await s.checkout.balance(mid)).availableCents, 1_550);
  assert.equal((await s.pool.query("SELECT count(*)::int AS n FROM app_checkout WHERE settled_seq IS NULL")).rows[0].n, 0);

  // A rival merchant's balance is untouched, and nothing is credited for an unpaid checkout.
  const rival = await s.checkout.createMerchant({ name: "Rival", email: `r${randomBytes(3).toString("hex")}@example.com` });
  await s.checkout.create(rival.merchantId, { amountCents: 100, description: "unpaid" });
  assert.equal((await s.checkout.balance(rival.merchantId)).availableCents, 0);
});

test("settlement: a charge approved after its checkout moved on is not credited to the merchant", { skip }, async () => {
  const s = await setup();
  const [x, y] = [await s.agent("x"), await s.agent("y")];
  const mid = s.merchant.merchantId;
  const c = await s.checkout.create(mid, { amountCents: 700, description: "stalled" });
  // x claims attempt 1 and stalls before its payment is recorded; the claim goes stale and is released.
  await s.pool.query("UPDATE app_checkout SET status = 'processing', card_id = $2, agent_id = $3, attempt = 1, claimed_at = now() WHERE checkout_id = $1", [c.checkoutId, x.p.cardId, x.p.agentId]);
  await s.checkoutFor(s.app, later(11 * 60_000)).sync();
  assert.equal((await s.checkout.pay(y.p, c.checkoutId)).checkout.status, "paid"); // attempt 2
  // x's process wakes up and its attempt-1 charge comes back approved.
  const late = { spendId: "sp_late", amountCents: 700, merchant: "Acme API", mcc: "5734", status: "approved" as const, reason: null, createdAt: new Date().toISOString() };
  await (s.checkout as unknown as { apply: (c: object, sp: object, m: string) => Promise<unknown> }).apply({ checkoutId: c.checkoutId, merchantId: mid, attempt: 1, amountCents: 700 }, late, "Acme API");
  await s.checkout.sync();
  assert.equal((await s.checkout.balance(mid)).availableCents, 700, "credited for one charge, not two");
  assert.ok((await s.checkout.getForMerchant(mid, c.checkoutId)).underReview);
});

test("payouts: reserved before anything is sent, never more than the balance, released only on a definite failure", { skip }, async () => {
  const s = await setup();
  const { p } = await s.agent();
  const mid = s.merchant.merchantId;
  const c = await s.checkout.create(mid, { amountCents: 1_000, description: "x" });
  await s.checkout.pay(p, c.checkoutId);
  await assert.rejects(s.checkout.requestPayout(mid, { amountCents: 100 }), /set a payout address first/);
  await s.checkout.setPayoutAddress(mid, { address: WALLET });

  await assert.rejects(s.checkout.requestPayout(mid, { amountCents: 1_001 }), /more than the available balance/);
  for (const bad of [{ amountCents: 0 }, { amountCents: 1.5 }, {}]) await assert.rejects(s.checkout.requestPayout(mid, bad), (e: { status?: number }) => e.status === 400);

  const [a, b] = await Promise.all([s.checkout.requestPayout(mid, { amountCents: 600, idempotencyKey: "po-1" }), s.checkout.requestPayout(mid, { amountCents: 600, idempotencyKey: "po-1" })]);
  assert.equal(a.payoutId, b.payoutId);
  assert.equal(a.status, "requested");
  await assert.rejects(s.checkout.requestPayout(mid, { amountCents: 500, idempotencyKey: "po-1" }), /different payout/);
  assert.deepEqual(await s.checkout.balance(mid), { availableCents: 400, pendingPayoutCents: 600, currency: "USD" });
  // Two concurrent payouts that together exceed the balance: one fails.
  const race = await Promise.allSettled([s.checkout.requestPayout(mid, { amountCents: 300 }), s.checkout.requestPayout(mid, { amountCents: 300 })]);
  assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
  assert.deepEqual(await s.checkout.balance(mid), { availableCents: 100, pendingPayoutCents: 900, currency: "USD" });

  const failed = await s.checkout.settlePayout(a.payoutId, { sent: false, failure: "bank rejected the account" });
  assert.equal(failed.status, "failed");
  await s.checkout.settlePayout(a.payoutId, { sent: false, failure: "again" }); // idempotent
  await assert.rejects(s.checkout.settlePayout(a.payoutId, { sent: true }), /already failed/);
  assert.deepEqual(await s.checkout.balance(mid), { availableCents: 700, pendingPayoutCents: 300, currency: "USD" });

  const sent = (await s.checkout.listPayouts(mid)).find((x) => x.status === "requested")!;
  assert.equal((await s.checkout.settlePayout(sent.payoutId, { sent: true, railReference: "wire-1" })).status, "sent");
  await s.checkout.settlePayout(sent.payoutId, { sent: true });
  assert.deepEqual(await s.checkout.balance(mid), { availableCents: 700, pendingPayoutCents: 0, currency: "USD" });
  assert.equal(await s.ledger.balance(accounts.payouts()), 300);

  // A refund can take back at most what the checkout settled, and never more than the merchant still holds.
  await assert.rejects(s.ledger.refundCheckout({ merchantId: mid, checkoutId: c.checkoutId, amountCents: 1_001 }), /not settled/);
  await assert.rejects(s.ledger.refundCheckout({ merchantId: mid, checkoutId: c.checkoutId, amountCents: 1_000 }), /insufficient/);
  await s.ledger.refundCheckout({ merchantId: mid, checkoutId: c.checkoutId, amountCents: 700 });
  assert.equal((await s.checkout.balance(mid)).availableCents, 0);
  assert.equal((await s.checkout.listPayouts(s.merchant.merchantId)).length, 4, "including the failed over-balance and race attempts");
});

test("payout address: validated, never one of ours, and a change waits before it can be paid", { skip }, async () => {
  const s = await setup();
  const { p } = await s.agent();
  const mid = s.merchant.merchantId;
  const c = await s.checkout.create(mid, { amountCents: 1_000, description: "x" });
  await s.checkout.pay(p, c.checkoutId);
  for (const address of ["", "0x123", `0x${"0".repeat(40)}`, "1111111111111111111111111111111111111111"]) {
    await assert.rejects(s.checkout.setPayoutAddress(mid, { address }), (e: { status?: number }) => e.status === 400);
  }
  await assert.rejects(s.checkout.setPayoutAddress(mid, { address: s.OWN }), /belongs to Agent Cards/);

  const hour = 3_600_000;
  const slow = s.checkoutFor(s.app, undefined, hour);
  const prof = await slow.setPayoutAddress(mid, { address: WALLET });
  assert.equal(prof.payoutAddress, WALLET);
  assert.ok(new Date(prof.payoutAddressUsableFrom!).getTime() > Date.now() + hour - 60_000);
  await assert.rejects(slow.requestPayout(mid, { amountCents: 100 }), /changed recently/);
  await slow.setPayoutAddress(mid, { address: WALLET }); // the same address again does not restart the wait
  const queued = await s.checkoutFor(s.app, later(hour + 1_000), hour).requestPayout(mid, { amountCents: 100 });
  assert.equal(queued.destination, WALLET);
  assert.equal(queued.chain, "base-sepolia");

  // A new address (say, set with a stolen key) waits again, and does not redirect the payout already queued.
  const thief = "0x2222222222222222222222222222222222222222";
  await s.checkoutFor(s.app, later(hour + 2_000), hour).setPayoutAddress(mid, { address: thief });
  await assert.rejects(s.checkoutFor(s.app, later(hour + 3_000), hour).requestPayout(mid, { amountCents: 100 }), /changed recently/);
  assert.equal((await s.checkout.listPayouts(mid))[0]!.destination, WALLET);
});

function fakeRail() {
  const r = {
    nonce: 0,
    signFails: undefined as string | undefined,
    states: new Map<string, TransferState["state"]>(),
    signed: [] as { to: string; amountCents: number; txHash: string }[],
    broadcasts: [] as string[],
    broadcastFails: false,
    isFunded: false,
    failTo: undefined as string | undefined,
    async sign(a: { to: string; amountCents: number }): Promise<SignedTransfer> {
      if (r.signFails) throw new Error(r.signFails);
      if (a.to === r.failTo) throw new Error("execution reverted: blacklisted");
      const n = r.nonce++;
      const txHash = `0x${n.toString(16).padStart(64, "0")}`;
      r.signed.push({ ...a, txHash });
      return { txHash, rawTx: `raw-${n}`, nonce: n };
    },
    async broadcast(raw: string) {
      r.broadcasts.push(raw);
      if (r.broadcastFails) throw new Error("connection reset");
    },
    async state(t: { txHash: string }): Promise<TransferState> {
      return { state: r.states.get(t.txHash) ?? "pending" };
    },
    async funded() {
      return r.isFunded;
    },
  };
  return r;
}

test("payout sender: signs, stores, then broadcasts; settles from the chain; never sends twice or on absence", { skip }, async () => {
  const s = await setup();
  const { p } = await s.agent();
  const mid = s.merchant.merchantId;
  const c = await s.checkout.create(mid, { amountCents: 1_500, description: "x" });
  await s.checkout.pay(p, c.checkoutId);
  await s.checkout.setPayoutAddress(mid, { address: WALLET });
  const rail = fakeRail();
  const sender = new PayoutInteractor({ db: s.db, payouts: s.repos.payouts, ledger: s.ledger, checkout: s.checkout, rail });

  // Short of USDC in the payout account: nothing signed, it stays requested.
  const a = await s.checkout.requestPayout(mid, { amountCents: 1_000 });
  rail.signFails = "execution reverted: transfer amount exceeds balance";
  await sender.tick();
  assert.equal((await s.checkout.listPayouts(mid))[0]!.status, "requested");
  assert.equal(rail.broadcasts.length, 0);

  // Signed and stored before the broadcast; a lost broadcast is rebroadcast with the same bytes.
  rail.signFails = undefined;
  rail.broadcastFails = true;
  await Promise.all([sender.tick(), new PayoutInteractor({ db: s.db, payouts: s.repos.payouts, ledger: s.ledger, checkout: s.checkout, rail }).tick()]); // two processes
  assert.equal(rail.signed.length, 1, "one transfer signed");
  assert.deepEqual({ to: rail.signed[0]!.to, amountCents: rail.signed[0]!.amountCents }, { to: WALLET, amountCents: 1_000 });
  let po = (await s.checkout.listPayouts(mid))[0]!;
  assert.equal(po.status, "sending");
  assert.equal(po.txHash, rail.signed[0]!.txHash);
  await assert.rejects(s.checkout.settlePayout(a.payoutId, { sent: false, failure: "ops guess" }), /settled from the chain/);

  const b = await s.checkout.requestPayout(mid, { amountCents: 500 });
  rail.broadcastFails = false;
  await sender.tick(); // still pending: rebroadcast, and nothing new signed while one is in flight
  await sender.tick();
  assert.ok(rail.broadcasts.length >= 3 && rail.broadcasts.every((x) => x === "raw-0"), "only ever the same signed bytes");
  assert.equal(rail.signed.length, 1);

  rail.states.set(rail.signed[0]!.txHash, "confirmed");
  await sender.tick(); // settles a, then signs b
  po = (await s.checkout.listPayouts(mid)).find((x) => x.payoutId === a.payoutId)!;
  assert.equal(po.status, "sent");
  assert.equal(await s.ledger.balance(accounts.payouts()), 1_000);
  assert.equal(rail.signed.length, 2);

  // b reverts on chain: a definite failure, the money is back.
  rail.states.set(rail.signed[1]!.txHash, "reverted");
  await sender.tick();
  assert.equal((await s.checkout.listPayouts(mid)).find((x) => x.payoutId === b.payoutId)!.status, "failed");
  assert.deepEqual(await s.checkout.balance(mid), { availableCents: 500, pendingPayoutCents: 0, currency: "USD" });

  // Our nonce taken by another transaction: review, money stays reserved, the queue stops.
  const d = await s.checkout.requestPayout(mid, { amountCents: 200 });
  await sender.tick();
  rail.states.set(rail.signed[2]!.txHash, "replaced");
  await s.checkout.requestPayout(mid, { amountCents: 100 });
  await sender.tick();
  await sender.tick();
  assert.equal(rail.signed.length, 3, "nothing new signed behind a stuck transfer");
  const stuck = (await s.pool.query("SELECT status, needs_review FROM app_payout WHERE payout_id = $1", [d.payoutId])).rows[0];
  assert.equal(stuck.status, "sending");
  assert.match(stuck.needs_review, /needs review/);
  assert.equal((await s.checkout.balance(mid)).pendingPayoutCents, 300);

  // Its way out: only after review, only while needs_review is set; the queue then moves on.
  await assert.rejects(s.checkout.settlePayout(d.payoutId, { sent: false, failure: "ops" }), /settled from the chain/);
  const released = await s.checkout.settlePayout(d.payoutId, { sent: false, failure: "nonce reused; checked on the explorer" }, { afterReview: true });
  assert.equal(released.status, "failed");
  assert.equal((await s.checkout.balance(mid)).pendingPayoutCents, 100);
  await sender.tick();
  assert.equal(rail.signed.length, 4, "the queue moves on");
  const e = (await s.checkout.listPayouts(mid)).find((x) => x.status === "sending")!;
  await assert.rejects(s.checkout.settlePayout(e.payoutId, { sent: false, failure: "ops" }, { afterReview: true }), /not under review/);
});

test("payout: ops and the sender cannot both settle one payout", { skip }, async () => {
  const s = await setup();
  const { p } = await s.agent();
  const mid = s.merchant.merchantId;
  const c = await s.checkout.create(mid, { amountCents: 1_000, description: "x" });
  await s.checkout.pay(p, c.checkoutId);
  await s.checkout.setPayoutAddress(mid, { address: WALLET });
  const a = await s.checkout.requestPayout(mid, { amountCents: 600 });
  // Ops reads 'requested'; before it moves any money, the sender signs it and moves it to 'sending'.
  const find = s.ledger.findByKey.bind(s.ledger);
  let flipped = false;
  s.ledger.findByKey = async (key: string) => {
    if (!flipped && key === `payout-reserve:${a.payoutId}`) {
      flipped = true;
      await s.pool.query("UPDATE app_payout SET status = 'sending', rail_reference = '0xabc', raw_tx = 'raw', nonce = 0 WHERE payout_id = $1", [a.payoutId]);
    }
    return find(key);
  };
  try {
    await assert.rejects(s.checkout.settlePayout(a.payoutId, { sent: false, failure: "cancel" }), (e: { status?: number }) => e.status === 409);
  } finally {
    s.ledger.findByKey = find;
  }
  assert.equal(await s.ledger.findByKey(`payout-release:${a.payoutId}`), undefined, "nothing released");
  assert.deepEqual(await s.checkout.balance(mid), { availableCents: 400, pendingPayoutCents: 600, currency: "USD" });
  assert.equal((await s.pool.query("SELECT status FROM app_payout WHERE payout_id = $1", [a.payoutId])).rows[0].status, "sending");
});

test("payout: a ledger step that throws after the row is claimed is finished by sync (Val's gap)", { skip }, async () => {
  const s = await setup();
  const { p } = await s.agent();
  const mid = s.merchant.merchantId;
  const c = await s.checkout.create(mid, { amountCents: 1_000, description: "x" });
  await s.checkout.pay(p, c.checkoutId);
  await s.checkout.setPayoutAddress(mid, { address: WALLET });
  const a = await s.checkout.requestPayout(mid, { amountCents: 600 });
  const b = await s.checkout.requestPayout(mid, { amountCents: 300 });
  const complete = s.ledger.completePayout.bind(s.ledger);
  const release = s.ledger.releasePayout.bind(s.ledger);
  s.ledger.completePayout = async () => { throw new Error("db down"); };
  s.ledger.releasePayout = async () => { throw new Error("db down"); };
  try {
    await assert.rejects(s.checkout.settlePayout(a.payoutId, { sent: true, railReference: "wire-a" }), /db down/);
    await assert.rejects(s.checkout.settlePayout(b.payoutId, { sent: false, failure: "rejected" }), /db down/);
  } finally {
    s.ledger.completePayout = complete;
    s.ledger.releasePayout = release;
  }
  // Rows say sent/failed, but the money is still pending.
  assert.deepEqual(await s.checkout.balance(mid), { availableCents: 100, pendingPayoutCents: 900, currency: "USD" });
  await s.checkout.sync();
  assert.deepEqual(await s.checkout.balance(mid), { availableCents: 400, pendingPayoutCents: 0, currency: "USD" });
  assert.equal(await s.ledger.balance(accounts.payouts()), 600);
  await s.checkout.sync(); // nothing left to do; no second entry
  assert.deepEqual(await s.checkout.balance(mid), { availableCents: 400, pendingPayoutCents: 0, currency: "USD" });
});

test("payout sender: a payout that fails on its own does not block the queue, and is failed after a few tries", { skip }, async () => {
  const s = await setup();
  const { p } = await s.agent();
  const mid = s.merchant.merchantId;
  const c = await s.checkout.create(mid, { amountCents: 1_000, description: "x" });
  await s.checkout.pay(p, c.checkoutId);
  const BAD = "0x3333333333333333333333333333333333333333";
  await s.checkout.setPayoutAddress(mid, { address: BAD });
  const a = await s.checkout.requestPayout(mid, { amountCents: 300 });
  await s.checkout.setPayoutAddress(mid, { address: WALLET });
  const b = await s.checkout.requestPayout(mid, { amountCents: 200 });
  const rail = fakeRail();
  rail.failTo = BAD;
  rail.isFunded = true;
  const sender = new PayoutInteractor({ db: s.db, payouts: s.repos.payouts, ledger: s.ledger, checkout: s.checkout, rail });
  await sender.tick();
  assert.deepEqual(rail.signed.map((x) => x.to), [WALLET], "b goes out past a");
  rail.states.set(rail.signed[0]!.txHash, "confirmed");
  for (let i = 0; i < MAX_SIGN_FAILURES; i++) await sender.tick();
  const all = await s.checkout.listPayouts(mid);
  assert.equal(all.find((x) => x.payoutId === b.payoutId)!.status, "sent");
  assert.equal(all.find((x) => x.payoutId === a.payoutId)!.status, "failed");
  assert.deepEqual(await s.checkout.balance(mid), { availableCents: 800, pendingPayoutCents: 0, currency: "USD" });
  assert.equal(rail.signed.length, 1, "the bad payout was never signed");
});

test("payout sender: a requested payout without a ledger reservation is never signed", { skip }, async () => {
  const s = await setup();
  const mid = s.merchant.merchantId;
  await s.checkout.setPayoutAddress(mid, { address: WALLET });
  await s.pool.query("INSERT INTO app_payout (payout_id, merchant_id, amount_cents, status, destination, chain) VALUES ('po_noreserve', $1, 100, 'requested', $2, 'base-sepolia')", [mid, WALLET]);
  const rail = fakeRail();
  await new PayoutInteractor({ db: s.db, payouts: s.repos.payouts, ledger: s.ledger, checkout: s.checkout, rail }).tick();
  assert.equal(rail.signed.length, 0);
});

test("checkout over HTTP with the SDK: merchant creates, agent pays, merchant sees paid", { skip }, async () => {
  const s = await setup();
  const { token } = await s.agent();
  const server = createAppServer({ cardholders: s.app, checkouts: s.checkout }, { allowedHosts: [] });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  server.close();
  const real = createAppServer({ cardholders: s.app, checkouts: s.checkout }, { allowedHosts: [`127.0.0.1:${port}`] });
  await new Promise<void>((r) => real.listen(port, "127.0.0.1", r));
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const signup = await AgentCardsCheckout.signup({ baseUrl }, { name: "Shop & <Co>", email: `sdk${randomBytes(3).toString("hex")}@example.com`, mcc: "5734" });
    const merchant = new AgentCardsCheckout({ baseUrl, secretKey: signup.secretKey });
    assert.equal((await merchant.me()).name, "Shop & <Co>");
    const c = await merchant.createCheckout({ amountCents: 999, description: "Pro plan, 1 month", reference: "inv-7", idempotencyKey: "inv-7" });
    assert.match(checkoutButton(c), /data-agent-cards-checkout="cs_/);
    assert.equal(parseCheckoutId(c.checkoutUrl), c.checkoutId);

    // The public page is escaped and tells an agent what to call.
    const page = await (await fetch(c.checkoutUrl.replace("http://127.0.0.1:8787", baseUrl))).text();
    assert.match(page, /Shop &#38; &#60;Co&#62;/);
    assert.doesNotMatch(page, /<Co>/);
    assert.match(page, /pay_checkout/);

    const agent = new AgentCardsAgent({ baseUrl, token });
    assert.equal((await agent.getCheckout(c.checkoutUrl)).amountCents, 999);
    const waiting = merchant.waitForPayment(c.checkoutId, { intervalMs: 500, timeoutMs: 10_000 });
    const paid = await agent.payCheckout(c.checkoutId);
    assert.equal(paid.payment.status, "approved");
    assert.equal((await waiting).status, "paid");
    assert.equal((await merchant.balance()).availableCents, 999);
    await assert.rejects(merchant.setPayoutAddress("not-an-address"), (e) => e instanceof AgentCardsError && e.status === 400);
    assert.equal((await merchant.setPayoutAddress(WALLET.toUpperCase().replace("0X", "0x"))).payoutAddress, WALLET);
    const po = await merchant.requestPayout({ amountCents: 500, idempotencyKey: "po-sdk" });
    assert.equal(po.status, "requested");
    assert.equal((await merchant.requestPayout({ amountCents: 500, idempotencyKey: "po-sdk" })).payoutId, po.payoutId);
    await assert.rejects(merchant.requestPayout({ amountCents: 500 }), (e) => e instanceof AgentCardsError && e.status === 409);
    assert.deepEqual((await merchant.listPayouts()).map((x) => x.status).sort(), ["failed", "requested"]);
    assert.deepEqual(await merchant.balance(), { availableCents: 499, pendingPayoutCents: 500, currency: "USD" });

    // Keys are not interchangeable.
    await assert.rejects(new AgentCardsCheckout({ baseUrl, secretKey: "mk_nope" }).listCheckouts(), (e) => e instanceof AgentCardsError && e.status === 401);
    const asAgent = await fetch(`${baseUrl}/merchant/v1/checkouts`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(asAgent.status, 401);
    const asMerchant = await fetch(`${baseUrl}/agent/v1/checkouts/${c.checkoutId}/pay`, { method: "POST", headers: { authorization: `Bearer ${signup.secretKey}`, "content-type": "application/json" }, body: "{}" });
    assert.equal(asMerchant.status, 401);
    assert.equal((await fetch(`${baseUrl}/v1/checkouts/cs_${"0".repeat(32)}`)).status, 404);
    assert.throws(() => new AgentCardsCheckout({ baseUrl: "http://shop.example", secretKey: signup.secretKey }), /plain http/);
  } finally {
    real.close();
  }
});
