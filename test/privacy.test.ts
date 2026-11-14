import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { AgentWallets } from "../src/lib/services/AgentWallets.js";
import { createDepositAddressRepository } from "../src/db/repositories/createChainRepositories.js";
import { DEFAULT_TIERS } from "../src/lib/services/tiers.js";
import { MidenBusinessError } from "../src/adapters/virtualCards/CardLifecycle.js";
import { CardService, ONE_TIME_TERMINATE_DAYS } from "../src/adapters/virtualCards/CardService.js";
import type { FundingRequest } from "../src/domain/interfaces/FundingSource.js";
import { Ledger } from "../src/lib/services/Ledger.js";
import { createDatabase } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createRepositories } from "../src/db/repositories/createRepositories.js";
import { MidenApiError } from "../src/lib/clients/cardIssuing/miden/MidenClient.js";
import { CardholderInteractor, midFor, type CardholderContext } from "../src/lib/interactors/CardholderInteractor.js";
import { DeveloperInteractor } from "../src/lib/interactors/DeveloperInteractor.js";
import { MemoryCardVault } from "../src/adapters/cardVault/CardVault.js";

// Runs only with DATABASE_URL (each case gets its own schema). Miden is faked.
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
  let cards = 0;
  const f = {
    mainFundCalls: [] as FundingRequest[],
    auths: [] as { cardId: string; amountDollars: number; mid?: string }[],
    oneTime: [] as { amountCents: number; clientReference: string; capture: boolean }[],
    /** What the next issueOneTime does. */
    issue: [] as ("ok" | "refuse" | "cap" | "lost")[],
    authorize: "approve" as "approve" | "hang",
    txns: [] as Record<string, unknown>[],
  };
  const deps = {
    lifecycle: {
      submitKyc: async () => ({ kycStatus: "Initiated" }),
      kycStatus: async () => ({ status: "Approved", customerId: "cust-1", kycToken: "kt" }),
      cardBalance: async () => 0,
      transactions: async (cardId: string, type?: string) => f.txns.filter((t) => t.cardId === cardId && (!type || t.transactionType === type)),
      simulateAuthorization: async (a: { cardId: string; amountDollars: number; mid?: string }) => {
        f.auths.push(a);
        if (f.authorize === "hang") {
          f.txns.push({ cardId: a.cardId, transactionType: "Authorization", transactionStatus: "Approved", transactionAmount: a.amountDollars, merchantMid: a.mid });
          throw new Error("socket hang up");
        }
        return `auth-${f.auths.length}`;
      },
    },
    cardIssuer: {
      issue: async (_a: string, policy: unknown) => ({ id: `card-${++cards}`, agentId: "x", policy }),
      issueOneTime: async (_kyc: unknown, amountCents: number, clientReference: string, o: { capture: boolean }) => {
        f.oneTime.push({ amountCents, clientReference, capture: o.capture });
        const mode = f.issue.shift() ?? "ok";
        if (mode === "refuse") throw new MidenBusinessError("Miden one-time card issuance failed: 117 Insufficient wallet balance");
        if (mode === "cap") throw new MidenApiError("POST", "/api/v2/cards/issue-lite", 400, JSON.stringify({ responseCode: "111", responseMessage: "Maximum Number of Cards Per customer Limit 3 Exceeded, Contact Support" }));
        if (mode === "lost") throw new Error("ETIMEDOUT");
        return { cardId: `lite-${++cards}`, lastFour: "4242", detailsCaptured: true };
      },
    },
    funding: { fund: async (r: FundingRequest) => (f.mainFundCalls.push(r), { id: "m1", status: "confirmed" as const }) },
  };
  let dev: DeveloperInteractor | undefined;
  const app = new CardholderInteractor({
    users: repos.users, cards: repos.cards, agents: repos.agents, spends: repos.spends, fundings: repos.fundings, oneTimeCards: repos.oneTimeCards,
    ledger, wallets: new AgentWallets(ledger), addresses: createDepositAddressRepository(db, "base-sepolia"),
    deriveAddress: (i: number) => `0x${i.toString(16).padStart(40, "0")}`, tiers: DEFAULT_TIERS, chain: "base-sepolia", sandbox: true, simulatedDeposits: true,
    onEvent: (u: string, t: string, d: Record<string, unknown>) => dev?.onEvent(u, t, d) ?? Promise.resolve(),
    ...deps,
  } as unknown as CardholderContext);
  dev = new DeveloperInteractor({ developers: repos.developers, webhookEvents: repos.webhookEvents, app, allowLocalWebhooks: false, publicUrl: "https://cards.example", resolve: async () => ["93.184.216.34"] });
  return { pool, app, dev, f };
}
type S = Awaited<ReturnType<typeof setup>>;

/** A developer, one of their users with KYC done and money on the card, and a funded agent ready to pay. */
async function payer(s: S, opts: { privacy?: boolean; developerDefault?: boolean } = {}) {
  const d = await s.dev.signup({ name: "Shopbot", email: `${randomBytes(3).toString("hex")}@dev.example` });
  if (opts.developerDefault) await s.dev.updateSettings(d.developerId, { privacyMode: true });
  const { user } = await s.dev.createUser(d.developerId, { externalId: "c1", email: `${randomBytes(3).toString("hex")}@example.com`, privacyMode: opts.privacy });
  await s.app.submitKyc(user.userId, KYC);
  await s.app.refresh(user.userId);
  await s.app.simulateDeposit(user.userId, 2_000);
  await s.app.fundPending();
  const agent = await s.app.createAgent(user.userId, { name: "bot", perTransactionCents: 1_000, dailyCents: 3_000 });
  await s.app.fundAgent(user.userId, agent.agentId, 2_000);
  const p = (await s.app.agentByToken(agent.token))!;
  return { d, user, agent, p, userId: user.userId };
}

test("privacy mode is fixed per user at creation: developer default, explicit choice, never flipped later", { skip }, async () => {
  const s = await setup();
  const d = await s.dev.signup({ name: "Shopbot", email: "a@dev.example" });
  const before = await s.dev.createUser(d.developerId, { externalId: "early", email: "early@example.com" });
  await s.dev.updateSettings(d.developerId, { privacyMode: true });
  const after = await s.dev.createUser(d.developerId, { externalId: "late", email: "late@example.com" });
  const optOut = await s.dev.createUser(d.developerId, { externalId: "opt-out", email: "oo@example.com", privacyMode: false });
  const optIn = await s.dev.createUser(d.developerId, { externalId: "opt-in", email: "oi@example.com", privacyMode: true });
  assert.equal(before.user.privacyMode, false, "turning the default on does not change existing users");
  assert.equal(after.user.privacyMode, true);
  assert.equal(optOut.user.privacyMode, false);
  assert.equal(optIn.user.privacyMode, true);
  await assert.rejects(s.dev.createUser(d.developerId, { externalId: "bad", email: "b@example.com", privacyMode: "yes" }), /true or false/);
  // Creating the same externalId again returns the user as they are.
  assert.equal((await s.dev.createUser(d.developerId, { externalId: "early", email: "early@example.com", privacyMode: true })).user.privacyMode, false);
});

test("a privacy user's deposit is credited to the ledger without a top-up of their own card", { skip }, async () => {
  const s = await setup();
  const normal = await payer(s);
  assert.equal(s.f.mainFundCalls.length, 1, "a normal user's money goes onto their card");
  const priv = await payer(s, { privacy: true });
  assert.equal(s.f.mainFundCalls.length, 1, "a privacy user's money stays in the wallet");
  const o = await s.app.overview(priv.userId);
  assert.equal(o.card!.balances.unallocatedOnCardCents, 0, "it moved on to the agent");
  assert.equal(o.card!.fundings[0]!.status, "completed");
  assert.match(o.card!.fundings[0]!.detail!, /privacy mode/);
  assert.equal(o.privacyMode, true);
  assert.equal((await s.app.overview(normal.userId)).privacyMode, false);
});

test("each payment gets its own one-time card for exactly its amount; the user's own card is never charged", { skip }, async () => {
  const s = await setup();
  const u = await payer(s, { privacy: true });
  const mainCard = (await s.app.overview(u.userId)).card!.cardId;

  const a = await s.app.pay(u.p, { amountCents: 750, merchant: "Shop", idempotencyKey: "k1" });
  const b = await s.app.pay(u.p, { amountCents: 750, merchant: "Shop", idempotencyKey: "k2" });
  assert.equal(a.status, "approved");
  assert.equal(b.status, "approved");
  assert.deepEqual(s.f.oneTime.map((x) => x.amountCents), [750, 750]);
  assert.deepEqual(s.f.oneTime.map((x) => x.capture), [false, false], "the simulator needs no card details");
  assert.equal(new Set(s.f.auths.map((x) => x.cardId)).size, 2, "two payments, two different cards");
  assert.ok(s.f.auths.every((x) => x.cardId !== mainCard), "nothing was charged to the user's own card");
  const rows = (await s.pool.query("SELECT spend_id, charge_card_id FROM app_spend ORDER BY created_at")).rows;
  assert.deepEqual(rows.map((r) => r.charge_card_id).sort(), s.f.auths.map((x) => x.cardId).sort());
  assert.equal((await s.pool.query("SELECT count(*) AS n FROM app_one_time_card WHERE status = 'ready'")).rows[0].n, "2");

  // The same key again is the same payment: no third card, no second charge.
  const again = await s.app.pay(u.p, { amountCents: 750, merchant: "Shop", idempotencyKey: "k1" });
  assert.equal(again.spendId, a.spendId);
  assert.equal(s.f.oneTime.length, 2);
  assert.equal(s.f.auths.length, 2);

  // A user who is not in privacy mode keeps paying on their own card.
  const n = await payer(s);
  const nMain = (await s.app.overview(n.userId)).card!.cardId;
  await s.app.pay(n.p, { amountCents: 500, merchant: "Shop", idempotencyKey: "k1" });
  assert.equal(s.f.oneTime.length, 2);
  assert.equal(s.f.auths.at(-1)!.cardId, nMain);
});

test("when no one-time card can be made, the payment is voided, the money comes back, and nothing is charged", { skip }, async () => {
  const s = await setup();
  const u = await payer(s, { privacy: true });
  s.f.issue.push("cap");
  const capped = await s.app.pay(u.p, { amountCents: 500, merchant: "Shop", idempotencyKey: "k1" });
  assert.equal(capped.status, "voided");
  assert.match(capped.reason!, /Limit 3 Exceeded/);
  assert.match(capped.reason!, /nothing was charged/);
  assert.equal(s.f.auths.length, 0);
  assert.equal((await s.app.agentWallet(u.p)).balanceCents, 2_000);

  s.f.issue.push("refuse");
  const refused = await s.app.pay(u.p, { amountCents: 500, merchant: "Shop", idempotencyKey: "k2" });
  assert.equal(refused.status, "voided");
  assert.equal((await s.app.agentWallet(u.p)).balanceCents, 2_000);

  // The daily allowance was not used up by the failed attempts, and a later payment works.
  assert.equal((await s.app.pay(u.p, { amountCents: 1_000, merchant: "Shop", idempotencyKey: "k3" })).status, "approved");
  assert.equal((await s.pool.query("SELECT count(*) AS n FROM app_one_time_card WHERE status = 'failed'")).rows[0].n, "2");
});

test("a lost answer from the issue call is flagged for a person, never guessed at", { skip }, async () => {
  const s = await setup();
  const u = await payer(s, { privacy: true });
  s.f.issue.push("lost");
  const lost = await s.app.pay(u.p, { amountCents: 500, merchant: "Shop", idempotencyKey: "k1" });
  assert.equal(lost.status, "voided");
  assert.match(lost.reason!, /flagged for review/);
  assert.equal(s.f.auths.length, 0);
  assert.equal((await s.app.agentWallet(u.p)).balanceCents, 2_000);
  const row = (await s.pool.query("SELECT status, detail FROM app_one_time_card")).rows[0];
  assert.equal(row.status, "needs_review");
  assert.match(row.detail, /issue answer lost/);
  // The same spend asked again never makes a second card.
  await assert.rejects(s.app.chargeCardFor(u.p, (await s.pool.query("SELECT spend_id FROM app_spend")).rows[0].spend_id, 500, { needDetails: false }), /needs a person/);
  assert.equal(s.f.oneTime.length, 1);
});

test("a charge whose answer was lost is settled from the one-time card's own transactions", { skip }, async () => {
  const s = await setup();
  const u = await payer(s, { privacy: true });
  s.f.authorize = "hang";
  const hung = await s.app.pay(u.p, { amountCents: 600, merchant: "Shop", idempotencyKey: "k1" });
  assert.equal(hung.status, "processing");
  const cardId = s.f.auths[0]!.cardId;
  assert.ok(cardId.startsWith("lite-"));
  assert.equal(s.f.auths[0]!.mid, midFor(hung.spendId));
  // Reconcile looks on the one-time card, not the user's own card, for the per-spend merchant id.
  (s.app as unknown as { now: () => Date }).now = () => new Date(Date.now() + 5 * 60_000);
  await s.app.reconcileSpends();
  const after = await s.app.agentTransactions(u.p, 5);
  assert.equal(after[0]!.status, "approved");
});

test("one-time cards are sealed into the vault for a fill, and forgotten after it (vault discard)", { skip }, async () => {
  const vault = new MemoryCardVault();
  const details = { pan: "4242424242424242", cvv: "123", expMonth: 12, expYear: 2030, nameOnCard: "Ada Test" };
  await vault.put("lite-1", details);
  assert.equal(await vault.has("lite-1"), true);
  assert.ok(await vault.reveal("lite-1", "checkout:sw_1"));
  await vault.discard("lite-1", "checkout:sw_1:done");
  assert.equal(await vault.has("lite-1"), false);
  assert.equal(await vault.reveal("lite-1", "checkout:sw_1"), null);
  assert.deepEqual(vault.audit.map((a) => a.action), ["put", "reveal", "discard", "reveal_miss"]);
  // Discarding what is not there is harmless and leaves no false audit row.
  await vault.discard("lite-1", "checkout:sw_1:done");
  assert.equal(vault.audit.filter((a) => a.action === "discard").length, 1);
});

test("CardService.issueOneTime asks Miden for a one-swipe Lite card with exactly the amount", { skip: false }, async () => {
  const sent: { path: string; body: Record<string, unknown>; reference?: string }[] = [];
  const miden = {
    request: async (_m: string, path: string, body: Record<string, unknown>, o: { reference?: string }) => {
      sent.push({ path, body, reference: o.reference });
      return { isSuccessful: true, responseCode: "000", data: { cardId: "lite-9", lastFour: "4242" } };
    },
  };
  const svc = new CardService(miden as never, { fund: async () => ({ id: "x", status: "confirmed" as const }) }, () => new Date("2026-10-21T10:00:00Z"));
  const out = await svc.issueOneTime({ customerId: "cust-1", kycToken: "kt" }, 750, "ot-spend1", { capture: false });
  assert.deepEqual(out, { cardId: "lite-9", lastFour: "4242", detailsCaptured: false });
  const b = sent[0]!.body;
  assert.equal(sent[0]!.path, "/api/v2/cards/issue-lite");
  assert.equal(b.swipeCount, 1);
  assert.equal(b.cardBalance, 7.5);
  assert.equal(b.clientReference, "ot-spend1");
  assert.equal(b.expirationDate, "2029-11-21");
  assert.equal(b.terminateDate, `2026-10-${21 + ONE_TIME_TERMINATE_DAYS}`);
  // Below Miden's $1 minimum card balance, the card is made with $1.
  await svc.issueOneTime({ customerId: "cust-1", kycToken: "kt" }, 40, "ot-spend2", { capture: false });
  assert.equal(sent[1]!.body.cardBalance, 1);
  // The Reference header is derived from the clientReference, so a retried issue is idempotent.
  await svc.issueOneTime({ customerId: "cust-1", kycToken: "kt" }, 750, "ot-spend1", { capture: false });
  assert.equal(sent[2]!.reference, sent[0]!.reference);
  // A 200 that says no is a business refusal.
  const no = new CardService({ request: async () => ({ isSuccessful: false, responseCode: "117", responseMessage: "no" }) } as never, { fund: async () => ({ id: "x", status: "confirmed" as const }) });
  await assert.rejects(no.issueOneTime({ customerId: "c", kycToken: "k" }, 500, "r", { capture: false }), MidenBusinessError);
  await assert.rejects(no.issueOneTime({ customerId: "c", kycToken: "k" }, 0, "r", { capture: false }), /positive whole number/);
});

test("privacy mode refuses payments under $1 and caps one-time cards per day, both before any card is made", { skip }, async () => {
  const s = await setup();
  const u = await payer(s, { privacy: true });
  const small = await s.app.pay(u.p, { amountCents: 50, merchant: "Shop", idempotencyKey: "small" });
  assert.equal(small.status, "voided");
  assert.match(small.reason ?? "", /at least \$1/);
  assert.equal(s.f.oneTime.length, 0);
  await s.pool.query("INSERT INTO app_one_time_card (one_time_id, user_id, spend_id, amount_cents, status) SELECT 'ot_x' || g, $1, 'sp_x' || g, 100, 'failed' FROM generate_series(1, 50) g", [u.userId]);
  const capped = await s.app.pay(u.p, { amountCents: 200, merchant: "Shop", idempotencyKey: "capped" });
  assert.equal(capped.status, "voided");
  assert.match(capped.reason ?? "", /one-time cards a day/);
  assert.equal(s.f.oneTime.length, 0);
});
