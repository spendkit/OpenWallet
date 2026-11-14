import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { AgentWallets } from "../src/lib/services/AgentWallets.js";
import { createDepositAddressRepository } from "../src/db/repositories/createChainRepositories.js";
import { DEFAULT_TIERS } from "../src/lib/services/tiers.js";
import { Ledger, accounts } from "../src/lib/services/Ledger.js";
import { createDatabase } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createRepositories } from "../src/db/repositories/createRepositories.js";
import { MidenApiError } from "../src/lib/clients/cardIssuing/miden/MidenClient.js";
import { CardholderInteractor, type CardholderContext } from "../src/lib/interactors/CardholderInteractor.js";
import { MemoryCardVault, type CardDetails } from "../src/adapters/cardVault/CardVault.js";
import { parseUsdCents, scrub, type CheckoutFiller, type FillRequest, type FillResult } from "../src/adapters/checkoutFillers/CheckoutFiller.js";
import { cardFree, PlaywrightFiller } from "../src/adapters/checkoutFillers/PlaywrightFiller.js";
import { startCheckoutFixture, type CheckoutFixture } from "../src/adapters/checkoutFillers/fixtures/stripeFixture.js";
import { isStripeTestUrl, parseCardTime, SwapInteractor, swapConfigFromEnv, type SwapConfig } from "../src/lib/interactors/SwapInteractor.js";
import { AgentCardsError } from "../src/errors.js";
import { SwapLiveFeed, type SwapLiveEvent } from "../src/lib/services/SwapLiveFeed.js";

const TEST_CARD: CardDetails = { pan: "4242424242424242", cvv: "123", expMonth: 12, expYear: 2030, nameOnCard: "Ada Test", billingZip: "94000" };
const card = (): CardDetails => ({ ...TEST_CARD });
const ONE_TIME_PAN = "5555555555554444";

// ---------- pure helpers ----------

test("swap: parseUsdCents reads Stripe-style totals", () => {
  assert.equal(parseUsdCents("$10.00"), 1000);
  assert.equal(parseUsdCents("US$1,234.5"), 123450);
  assert.equal(parseUsdCents("Total due 9.99 USD"), 999);
  assert.equal(parseUsdCents("€10.00"), undefined);
  assert.equal(parseUsdCents(""), undefined);
});

test("swap: parseCardTime treats Miden's zone-less times as UTC", () => {
  assert.equal(parseCardTime("2026-10-19T14:11:54.689346"), Date.parse("2026-10-19T14:11:54.689Z"));
  assert.equal(parseCardTime("2026-10-19T14:11:54Z"), Date.parse("2026-10-19T14:11:54Z"));
  assert.equal(parseCardTime(undefined), undefined);
});

test("swap: scrub blanks every field; cardFree strips card values from error text", () => {
  const c = card();
  scrub(c);
  assert.deepEqual(c, { pan: "", cvv: "", expMonth: 0, expYear: 0, nameOnCard: "", billingZip: "" });
  const msg = cardFree(new Error(`fill failed for 4242424242424242 cvc 123 and 4242 4242 4242 4242`), { card: card() });
  assert.doesNotMatch(msg, /4242424242424242|4242 4242 4242 4242|\b123\b/);
});

test("swap: config defaults to off, Stripe only, $10 cap", () => {
  const c = swapConfigFromEnv({});
  assert.deepEqual(c, { enabled: false, maxAmountCents: 1000, allowedHosts: ["checkout.stripe.com", "buy.stripe.com"], insecureHosts: [], fallbackEmail: undefined, stripeTestCard: false, testHosts: [], openHosts: false });
  assert.deepEqual([swapConfigFromEnv({ SWAP_OPEN_HOSTS: "1", SWAP_TEST_HOSTS: "LocalHost:8790, shop.test" }).openHosts, swapConfigFromEnv({ SWAP_TEST_HOSTS: "LocalHost:8790, shop.test" }).testHosts], [true, ["localhost:8790", "shop.test"]]);
  assert.throws(() => swapConfigFromEnv({ SWAP_MAX_CENTS: "ten" }), /SWAP_MAX_CENTS/);
});

test("swap: only Stripe test-mode links count as test links", () => {
  assert.equal(isStripeTestUrl("https://checkout.stripe.com/c/pay/cs_test_a1#fid"), true);
  assert.equal(isStripeTestUrl("https://buy.stripe.com/test_abc123"), true);
  assert.equal(isStripeTestUrl("https://checkout.stripe.com/c/pay/cs_live_a1"), false);
  assert.equal(isStripeTestUrl("https://buy.stripe.com/abc123"), false);
  assert.equal(isStripeTestUrl("https://buy.stripe.com/abc/test_1"), false, "test_ must start the path");
  assert.equal(isStripeTestUrl("https://evil.example/c/pay/cs_test_a1"), false);
  assert.equal(isStripeTestUrl("http://checkout.stripe.com/c/pay/cs_test_a1"), false);
  assert.equal(isStripeTestUrl("https://checkout.stripe.com/c/pay/cs_live_a1?x=cs_test_"), false, "the query does not count");
  assert.equal(isStripeTestUrl("https://checkout.stripe.com/c/pay/cs_live_a/cs_test_x"), false, "a live session id anywhere in the path is not a test link");
  assert.equal(isStripeTestUrl("https://checkout.stripe.com/c/pay/cs_test_x/cs_live_a"), false, "a live session id last is live");
  assert.equal(isStripeTestUrl("https://checkout.stripe.com/test_abc"), false, "test_ only counts on buy.stripe.com");
  assert.equal(isStripeTestUrl("https://buy.stripe.com/c/pay/cs_test_a1"), false, "cs_test_ only counts on checkout.stripe.com");
  assert.equal(isStripeTestUrl("https://checkout.stripe.com@evil.example/c/pay/cs_test_a1"), false);
  assert.equal(swapConfigFromEnv({ SWAP_STRIPE_TEST_CARD: "1" }).stripeTestCard, true);
});

// ---------- the real browser against the local Stripe-like fixture ----------

const browserSkip = process.env.SKIP_BROWSER === "1";
let fx: CheckoutFixture | undefined;
let browser: import("playwright-core").Browser | undefined;
before(async () => {
  if (browserSkip) return;
  fx = await startCheckoutFixture();
  browser = await (await import("playwright-core")).chromium.launch();
});
after(async () => {
  await browser?.close();
  await fx?.close();
});
const fillAt = (scenario: string, amount = 1000, expected = 1000, resultTimeoutMs = 5_000) =>
  new PlaywrightFiller({ browser, resultTimeoutMs, loadTimeoutMs: 10_000 }).fill({ url: fx!.url(scenario, amount), expectedAmountCents: expected, card: card(), email: "owner@example.com" });

test("filler: success redirect, complete state and accordion all count as succeeded", { skip: browserSkip }, async () => {
  for (const s of ["success", "complete", "accordion"]) {
    const r = await fillAt(s);
    assert.equal(r.outcome, "succeeded", s);
    assert.equal(r.submitted, true);
    assert.equal(r.pageAmountCents, 1000);
  }
  assert.deepEqual(fx!.submissions.slice(-3).map((x) => x.last4), ["4242", "4242", "4242"], "the card reached the form");
});

test("filler: with a viewer, the fill is narrated step by step and streamed as frames, and still pays", { skip: browserSkip }, async () => {
  const steps: string[] = [];
  let frames = 0;
  const r = await new PlaywrightFiller({ browser, resultTimeoutMs: 5_000, loadTimeoutMs: 10_000 }).fill({
    url: fx!.url("success", 1000), expectedAmountCents: 1000, card: card(), email: "owner@example.com",
    watch: { step: (l) => steps.push(l), frame: () => frames++ },
  });
  assert.equal(r.outcome, "succeeded");
  assert.equal(fx!.submissions.at(-1)!.last4, "4242", "typed key by key, the card still reaches the form");
  for (const want of [/Opening/, /Page total is \$10\.00/, /card number/, /expiry/, /CVC/, /Pressing Pay/, /Payment succeeded/]) {
    assert.ok(steps.some((x) => want.test(x)), `step ${want}`);
  }
  assert.ok(frames > 0, "frames were streamed");
});

test("filler: a page total that differs stops before any card data is typed", { skip: browserSkip }, async () => {
  const before = fx!.submissions.length;
  const r = await fillAt("success", 1200, 1000);
  assert.deepEqual({ outcome: r.outcome, submitted: r.submitted, page: r.pageAmountCents }, { outcome: "amount_mismatch", submitted: false, page: 1200 });
  assert.equal(fx!.submissions.length, before);
  assert.equal((await fillAt("nototal")).outcome, "unsupported_page");
});

test("filler: decline, captcha, 3-D Secure and a silent page are told apart", { skip: browserSkip }, async () => {
  const d = await fillAt("decline");
  assert.deepEqual([d.outcome, d.submitted], ["declined", true]);
  const c = await fillAt("captcha");
  assert.deepEqual([c.outcome, c.submitted], ["captcha", false], "a bot check up front: never submitted");
  const t = await fillAt("three_ds");
  assert.deepEqual([t.outcome, t.submitted], ["three_ds", true]);
  const h = await fillAt("hang", 1000, 1000, 1_500);
  assert.deepEqual([h.outcome, h.submitted], ["error", true], "no answer after submit: unknown, never 'failed'");
  for (const r of [d, c, t, h]) assert.doesNotMatch(JSON.stringify(r), /4242424242424242|"123"/);
});

test("filler: a session that needs a full billing address is filled from the vault, or refused before paying", { skip: browserSkip }, async () => {
  const before = fx!.submissions.length;
  const bare = await fillAt("address");
  assert.deepEqual([bare.outcome, bare.submitted], ["unsupported_page", false], "no address on file: stop before pressing pay");
  assert.match(bare.detail!, /billing address/);
  assert.equal(fx!.submissions.length, before, "nothing sent");
  const withAddr = await new PlaywrightFiller({ browser, resultTimeoutMs: 5_000, loadTimeoutMs: 10_000 }).fill({
    url: fx!.url("address", 1000), expectedAmountCents: 1000, email: "owner@example.com",
    card: { ...card(), billingAddress: { line1: "1 Market St", city: "San Francisco", state: "CA", country: "US" } },
  });
  assert.deepEqual([withAddr.outcome, withAddr.submitted], ["succeeded", true]);
});

// ---------- SwapInteractor against Postgres, with a fake filler ----------

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

class FakeFiller implements CheckoutFiller {
  next: FillResult = { outcome: "succeeded", submitted: true };
  calls: FillRequest[] = [];
  /** The card number the filler must be handed (a privacy user's one-time card has its own). */
  expectPan = TEST_CARD.pan;
  async fill(req: FillRequest): Promise<FillResult> {
    this.calls.push(req);
    assert.equal(req.card.pan, this.expectPan, "the filler gets the real card while it runs");
    return this.next;
  }
}

async function setup(cfg: Partial<SwapConfig> = {}, opts: { privacy?: boolean; live?: SwapLiveFeed } = {}) {
  const schema = `t_${randomBytes(6).toString("hex")}`;
  await admin!.query(`CREATE SCHEMA ${schema}`);
  schemas.push(schema);
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 6 });
  pools.push(pool);
  await migrate(pool);
  const db = createDatabase(pool);
  const repos = createRepositories(db);
  const ledger = new Ledger(undefined, repos.ledger);
  const txns: Record<string, unknown>[] = [];
  const asked: string[] = [];
  const lifecycle = {
    submitKyc: async () => ({ kycStatus: "Initiated" }),
    kycStatus: async () => ({ status: "Approved", customerId: "cust-1", kycToken: "kt" }),
    cardBalance: async () => 0,
    simulateAuthorization: async () => { throw new Error("a swap must never use the simulator"); },
    transactions: async (cardId: string, type?: string) => (asked.push(cardId), txns).filter((t) => t.cardId === cardId && (!type || t.transactionType === type)),
  };
  let clock = Date.now();
  const vaultRef: { v?: MemoryCardVault } = {};
  const oneTimeCards: string[] = [];
  const app = new CardholderInteractor({
    users: repos.users, cards: repos.cards, agents: repos.agents, spends: repos.spends, fundings: repos.fundings, oneTimeCards: repos.oneTimeCards,
    ledger, wallets: new AgentWallets(ledger), addresses: createDepositAddressRepository(db, "base-sepolia"),
    deriveAddress: (i: number) => `0x${i.toString(16).padStart(40, "0")}`, tiers: DEFAULT_TIERS, chain: "base-sepolia", sandbox: true, simulatedDeposits: true,
    lifecycle,
    cardIssuer: {
      issue: async (_a: string, policy: unknown) => ({ id: `card-${randomBytes(3).toString("hex")}`, agentId: "x", policy, detailsCaptured: true }),
      // Like the real service: a one-time card's details are sealed into the vault when it is issued.
      issueOneTime: async (_k: unknown, _amount: number, _ref: string, o: { capture: boolean }) => {
        const cardId = `lite-${randomBytes(3).toString("hex")}`;
        if (o.capture) await vaultRef.v!.put(cardId, { ...card(), pan: ONE_TIME_PAN });
        oneTimeCards.push(cardId);
        return { cardId, lastFour: ONE_TIME_PAN.slice(-4), detailsCaptured: o.capture };
      },
    },
    funding: { fund: async () => ({ id: "m1", status: "confirmed" as const }) },
    now: () => new Date(clock),
  } as unknown as CardholderContext);
  const { userId } = await app.signup(`u${randomBytes(3).toString("hex")}@example.com`);
  if (opts.privacy) await pool.query("UPDATE app_user SET privacy_mode = true WHERE id = $1", [userId]);
  await app.submitKyc(userId, KYC);
  await app.simulateDeposit(userId, 5_000);
  await app.fundPending();
  const a = await app.createAgent(userId, { name: "bot", perTransactionCents: 1_500, dailyCents: 3_000 });
  await app.fundAgent(userId, a.agentId, 2_000);
  const p = (await app.agentByToken(a.token))!;
  const vault = new MemoryCardVault();
  vaultRef.v = vault;
  await vault.put(p.cardId, card());
  const filler = new FakeFiller();
  if (opts.privacy) filler.expectPan = ONE_TIME_PAN;
  const swap = new SwapInteractor({
    swaps: repos.swaps, app, vault, filler, lifecycle, now: () => new Date(clock), ...(opts.live ? { live: opts.live } : {}),
    config: { enabled: true, maxAmountCents: 1_000, allowedHosts: ["checkout.stripe.com"], ...cfg },
  });
  const balance = () => ledger.balance(accounts.agent(p.cardId, a.agentId));
  const age = async (ms: number) => {
    clock += ms;
    await pool.query("UPDATE app_checkout_swap SET created_at = created_at - make_interval(secs => $1), updated_at = updated_at - make_interval(secs => $1)", [ms / 1000]);
  };
  return { app, swap, filler, vault, pool, p, balance, txns, age, oneTimeCards, asked };
}

const URL1 = "https://checkout.stripe.com/c/pay/cs_test_a1";
const req = (over: Record<string, unknown> = {}) => ({ checkoutUrl: URL1, amountCents: 1_000, merchant: "Acme", idempotencyKey: "k1", ...over });

test("swap: pays, debits the agent once, audits the reveal, scrubs the card", { skip }, async () => {
  const s = await setup();
  const [a, b] = await Promise.all([s.swap.pay(s.p, req()), s.swap.pay(s.p, req())]);
  assert.equal(a.status, "paid");
  assert.equal(b.swapId, a.swapId);
  assert.equal(s.filler.calls.length, 1, "filled once");
  assert.equal((await s.swap.pay(s.p, req())).status, "paid");
  assert.equal(s.filler.calls.length, 1, "a retry never fills again");
  assert.equal(await s.balance(), 1_000);
  assert.equal(a.payment?.status, "approved");
  assert.equal(s.filler.calls[0]!.card.pan, "", "details scrubbed after the attempt");
  assert.equal(s.filler.calls[0]!.email.endsWith("@example.com"), true, "receipt goes to the owner");
  assert.deepEqual(s.vault.audit.filter((x) => x.action === "reveal").map((x) => x.purpose), [`checkout:${a.swapId}`]);
  assert.doesNotMatch(JSON.stringify(a), /4242|cvv|pan/i);
  await assert.rejects(s.swap.pay(s.p, req({ amountCents: 900 })), (e: { status?: number }) => e.status === 409, "same key, different payment");
});

test("swap, Stripe test card: a test link is paid with 4242 without opening the vault; a live link still uses the vault", { skip }, async () => {
  const s = await setup({ stripeTestCard: true });
  s.filler.expectPan = "4242424242424242";
  await s.vault.discard(s.p.cardId, "test");
  await assert.rejects(s.swap.pay(s.p, req({ checkoutUrl: "https://checkout.stripe.com/c/pay/cs_live_b2", idempotencyKey: "k0" })), /not on file/, "a live link still needs the vaulted card");
  const a = await s.swap.pay(s.p, req());
  assert.equal(a.status, "paid");
  assert.equal(await s.balance(), 1_000, "the agent is still debited");
  assert.equal(s.vault.audit.filter((x) => x.action === "reveal").length, 0, "the vault is never opened");
  assert.equal(s.filler.calls[0]!.card.pan, "", "scrubbed after the attempt");
  await s.age(31 * 60_000);
  await s.swap.reconcile();
  assert.equal((await s.swap.get(s.p, a.swapId)).underReview, null, "no card authorization is expected, so nothing goes to review");

  s.filler.expectPan = TEST_CARD.pan;
  await s.vault.put(s.p.cardId, card());
  const live = await s.swap.pay(s.p, req({ checkoutUrl: "https://checkout.stripe.com/c/pay/cs_live_b2", amountCents: 500, idempotencyKey: "k2" }));
  assert.equal(live.status, "paid");
  assert.equal(s.vault.audit.filter((x) => x.action === "reveal").length, 1, "a live link gets the vaulted card");
});

test("swap, live view: only a Stripe test-card payment is watched; a vaulted card never gets a viewer", { skip }, async () => {
  const feed = new SwapLiveFeed();
  const s = await setup({ stripeTestCard: true }, { live: feed });
  const seen: SwapLiveEvent[] = [];
  const otherAgent: SwapLiveEvent[] = [];
  feed.subscribe(s.p.agentId, (e) => seen.push(e));
  feed.subscribe("a_someone_else", (e) => otherAgent.push(e));

  s.filler.expectPan = "4242424242424242";
  const a = await s.swap.pay(s.p, req());
  assert.equal(a.status, "paid");
  const watch = s.filler.calls[0]!.watch;
  assert.ok(watch, "the test-card fill gets a viewer");
  watch.step("Typing the card number");
  assert.deepEqual(seen.map((e) => e.type), ["start", "end", "step"]);
  assert.ok(seen.every((e) => e.swapId === a.swapId));
  assert.equal(otherAgent.length, 0, "another agent's viewer sees nothing");

  s.filler.expectPan = TEST_CARD.pan;
  const live = await s.swap.pay(s.p, req({ checkoutUrl: "https://checkout.stripe.com/c/pay/cs_live_b2", amountCents: 500, idempotencyKey: "k2" }));
  assert.equal(live.status, "paid");
  assert.equal(s.filler.calls[1]!.watch, undefined, "a real card's page is never watched");
  assert.equal(seen.filter((e) => e.swapId === live.swapId).length, 0, "and nothing about it is published");
});

test("swap, Stripe test card: an unclear page result is never matched to a real card authorization", { skip }, async () => {
  const s = await setup({ stripeTestCard: true });
  s.filler.expectPan = "4242424242424242";
  s.filler.next = { outcome: "error", submitted: true, detail: "no answer after submit" };
  const a = await s.swap.pay(s.p, req());
  assert.equal(a.status, "processing");
  // A real $10.00 authorization on the same card, the kind reconcile would otherwise claim.
  s.txns.push({ cardId: s.p.cardId, transactionType: "Authorization", transactionStatus: "Approved", transactionAmount: 10, transactionReference: "real-1", authCode: "A1", transactionTime: new Date().toISOString().replace("Z", "") });
  await s.age(61_000);
  await s.swap.reconcile();
  assert.equal((await s.swap.get(s.p, a.swapId)).status, "processing", "not settled by someone else's authorization");
  await s.age(31 * 60_000);
  await s.swap.reconcile();
  const v = await s.swap.get(s.p, a.swapId);
  assert.equal(v.status, "needs_review");
  assert.equal(v.payment?.status, "processing", "the money stays held for a person");
  assert.deepEqual(s.asked, [], "the card network is never asked about a test-card payment");
});

test("swap: refuses before reserving anything: off, over the cap, wrong host, no key, no card on file", { skip }, async () => {
  const s = await setup();
  const st = (n: number) => (e: { status?: number }) => e.status === n;
  await assert.rejects(s.swap.pay(s.p, req({ amountCents: 1_001 })), st(400));
  await assert.rejects(s.swap.pay(s.p, req({ checkoutUrl: "https://evil.example/c/pay/x" })), st(400));
  await assert.rejects(s.swap.pay(s.p, req({ checkoutUrl: "http://checkout.stripe.com/c/pay/x" })), st(400));
  await assert.rejects(s.swap.pay(s.p, req({ idempotencyKey: "" })), st(400));
  const off = new SwapInteractor({ ...(s.swap as any).d, config: { enabled: false, maxAmountCents: 1000, allowedHosts: ["checkout.stripe.com"] } });
  await assert.rejects(off.pay(s.p, req()), st(403));
  const empty = new SwapInteractor({ ...(s.swap as any).d, vault: new MemoryCardVault() });
  await assert.rejects(empty.pay(s.p, req()), /not on file/);
  assert.equal(s.filler.calls.length, 0);
  assert.equal(await s.balance(), 2_000);
  assert.equal((await s.pool.query("SELECT count(*)::int AS n FROM app_spend")).rows[0].n, 0);
});

test("swap: an agent cannot pre-spend under a swap key, and the agent's limits still apply", { skip }, async () => {
  const s = await setup({ maxAmountCents: 5_000 });
  await assert.rejects(s.app.pay(s.p, { amountCents: 1, merchant: "x", idempotencyKey: "checkout:swap:sw_x" }), (e: { status?: number }) => e.status === 400);
  const r = await s.swap.pay(s.p, req({ amountCents: 1_600 }));
  assert.equal(r.status, "failed");
  assert.match(r.payment!.reason!, /per-transaction/);
  assert.equal(s.filler.calls.length, 0, "the card is never revealed when limits say no");
  assert.equal(s.vault.audit.filter((x) => x.action === "reveal").length, 0);
});

test("swap: nothing submitted (price mismatch, bot check) undoes the debit; a challenge is final under its key", { skip }, async () => {
  const s = await setup();
  s.filler.next = { outcome: "amount_mismatch", submitted: false, pageAmountCents: 1200, detail: "page total $12.00, expected $10.00" };
  const m = await s.swap.pay(s.p, req());
  assert.equal(m.status, "failed");
  assert.equal(m.payment!.status, "voided");
  assert.match(m.payment!.reason!, /price/);
  assert.equal(await s.balance(), 2_000);

  s.filler.next = { outcome: "captcha", submitted: false };
  const c = await s.swap.pay(s.p, req({ idempotencyKey: "k2" }));
  assert.equal(c.status, "challenge");
  assert.equal(await s.balance(), 2_000);
  s.filler.next = { outcome: "succeeded", submitted: true };
  assert.equal((await s.swap.pay(s.p, req({ idempotencyKey: "k2" }))).status, "challenge", "never retried blind");
  assert.equal(s.filler.calls.length, 2);
});

test("swap: a decline on the page voids; a 3-D Secure challenge holds the money until the card says", { skip }, async () => {
  const s = await setup();
  s.filler.next = { outcome: "declined", submitted: true };
  assert.equal((await s.swap.pay(s.p, req())).status, "failed");
  assert.equal(await s.balance(), 2_000);

  s.filler.next = { outcome: "three_ds", submitted: true };
  const t = await s.swap.pay(s.p, req({ idempotencyKey: "k2" }));
  assert.equal(t.status, "challenge");
  assert.equal(t.payment!.status, "processing");
  assert.equal(await s.balance(), 1_000, "held");

  await s.app.reconcileSpends();
  assert.equal((await s.swap.get(s.p, t.swapId)).payment!.status, "processing", "CardholderInteractor's own reconcile leaves swap spends alone");

  // The card shows the authorization approved (the owner passed 3DS in time).
  await s.age(90_000);
  s.txns.push({ cardId: s.p.cardId, transactionType: "Authorization", transactionStatus: "Approved", transactionAmount: 10, transactionReference: "tx-1", authCode: "A1", transactionTime: new Date().toISOString().replace("Z", "") });
  await s.swap.reconcile();
  const done = await s.swap.get(s.p, t.swapId);
  assert.equal(done.status, "paid");
  assert.equal(done.payment!.status, "approved");
  assert.equal(await s.balance(), 1_000);
});

test("swap: reconcile voids on a card decline, and flags ambiguity or silence for a person", { skip }, async () => {
  const s = await setup();
  const now = () => new Date().toISOString().replace("Z", "");
  s.filler.next = { outcome: "error", submitted: true, detail: "timeout" };
  const a = await s.swap.pay(s.p, req({ idempotencyKey: "a" }));
  assert.equal(a.status, "processing");
  await s.age(90_000);
  s.txns.push({ cardId: s.p.cardId, transactionType: "Authorization", transactionStatus: "Declined", transactionAmount: 10, transactionReference: "tx-d", transactionTime: now() });
  await s.swap.reconcile();
  assert.equal((await s.swap.get(s.p, a.swapId)).status, "failed");
  assert.equal(await s.balance(), 2_000, "refunded on a definite decline");

  const b = await s.swap.pay(s.p, req({ idempotencyKey: "b" }));
  await s.age(31 * 60_000);
  await s.swap.reconcile();
  const bv = await s.swap.get(s.p, b.swapId);
  assert.equal(bv.status, "needs_review");
  assert.match(bv.payment!.reason!, /needs review/);
  assert.equal(await s.balance(), 1_000, "silence never refunds");

  const c = await s.swap.pay(s.p, req({ idempotencyKey: "c" }));
  await s.age(90_000);
  for (const ref of ["tx-x", "tx-y"]) s.txns.push({ cardId: s.p.cardId, transactionType: "Authorization", transactionStatus: "Approved", transactionAmount: 10, transactionReference: ref, transactionTime: now() });
  await s.swap.reconcile();
  // Two unclaimed $10 authorizations could each be this payment: never guess.
  assert.equal((await s.swap.get(s.p, c.swapId)).status, "needs_review");
});

test("swap: a paid swap is confirmed on the card, and a different merchant category is flagged (Kai's check)", { skip }, async () => {
  const s = await setup();
  const now = () => new Date().toISOString().replace("Z", "");
  const a = await s.swap.pay(s.p, req({ idempotencyKey: "a", mcc: "5734" }));
  assert.equal(a.status, "paid");
  await s.age(90_000);
  s.txns.push({ cardId: s.p.cardId, transactionType: "Authorization", transactionStatus: "Approved", transactionAmount: 10, transactionReference: "tx-a", merchantMcc: "5815", transactionTime: now() });
  await s.swap.reconcile();
  const av = await s.swap.get(s.p, a.swapId);
  assert.equal(av.status, "paid");
  assert.equal(av.underReview, "merchant category mismatch: declared 5734, card network saw 5815");
  const row = (await s.pool.query("SELECT card_txn_ref, card_mcc FROM app_checkout_swap WHERE swap_id = $1", [a.swapId])).rows[0];
  assert.deepEqual(row, { card_txn_ref: "tx-a", card_mcc: "5815" });

  // Paid on the page, but nothing on the card after 30 minutes: a person looks. The money stays where it is.
  const b = await s.swap.pay(s.p, req({ idempotencyKey: "b" }));
  await s.age(31 * 60_000);
  await s.swap.reconcile();
  assert.match((await s.swap.get(s.p, b.swapId)).underReview!, /no matching authorization/);
  assert.equal(await s.balance(), 0);
});

test("swap: a second payment of the same amount on the card waits while the first is unsettled (Kai's check)", { skip }, async () => {
  const s = await setup();
  const now = () => new Date().toISOString().replace("Z", "");
  s.filler.next = { outcome: "three_ds", submitted: true };
  const a = await s.swap.pay(s.p, req({ idempotencyKey: "a", amountCents: 400 }));
  assert.equal(a.status, "challenge");
  s.filler.next = { outcome: "succeeded", submitted: true };
  await assert.rejects(s.swap.pay(s.p, req({ idempotencyKey: "b", amountCents: 400 })), (e: AgentCardsError) => e.status === 409 && /still being confirmed/.test(e.message));
  assert.equal((await s.pool.query("SELECT count(*)::int AS n FROM app_checkout_swap")).rows[0].n, 1, "nothing written for the refused one");
  assert.equal((await s.swap.pay(s.p, req({ idempotencyKey: "a", amountCents: 400 }))).swapId, a.swapId, "a retry under the same key is never refused");
  assert.equal((await s.swap.pay(s.p, req({ idempotencyKey: "c", amountCents: 500 }))).status, "paid", "a different amount is not held up");

  // Left for a person, the first no longer blocks; but a lone authorization that either could own is not guessed.
  await s.pool.query("UPDATE app_checkout_swap SET status = 'needs_review' WHERE swap_id = $1", [a.swapId]);
  s.filler.next = { outcome: "error", submitted: true, detail: "timeout" };
  const b = await s.swap.pay(s.p, req({ idempotencyKey: "b", amountCents: 400 }));
  assert.equal(b.status, "processing");
  await s.age(90_000);
  s.txns.push({ cardId: s.p.cardId, transactionType: "Authorization", transactionStatus: "Approved", transactionAmount: 4, transactionReference: "tx-4", transactionTime: now() });
  await s.swap.reconcile();
  const bv = await s.swap.get(s.p, b.swapId);
  assert.equal(bv.status, "needs_review");
  assert.match(bv.payment!.reason!, /another open payment/);
  assert.equal((await s.pool.query("SELECT count(*)::int AS n FROM app_checkout_swap WHERE card_txn_ref = 'tx-4'")).rows[0].n, 0, "unclaimed");
});

test("swap, privacy mode: the page gets a one-time card, the user's own card is never revealed, and the details are discarded", { skip }, async () => {
  const s = await setup({}, { privacy: true });
  const r = await s.swap.pay(s.p, req());
  assert.equal(r.status, "paid");
  assert.equal(s.filler.calls.length, 1);
  assert.equal(s.oneTimeCards.length, 1);
  const lite = s.oneTimeCards[0]!;
  // Only the one-time card was revealed, once, and it is gone from the vault afterwards.
  assert.deepEqual(s.vault.audit.filter((x) => x.action === "reveal").map((x) => x.cardId), [lite]);
  assert.equal(await s.vault.has(lite), false);
  assert.ok(s.vault.audit.some((x) => x.action === "discard" && x.cardId === lite));
  assert.equal(await s.vault.has(s.p.cardId), true, "the user's own card is untouched");
  const row = (await s.pool.query("SELECT charge_card_id FROM app_checkout_swap")).rows[0];
  assert.equal(row.charge_card_id, lite);
  assert.equal(await s.balance(), 1_000);
  assert.doesNotMatch(JSON.stringify(r), /5555|4444|lite-/);
  // A retry under the same key is the same payment: no second card.
  await s.swap.pay(s.p, req());
  assert.equal(s.oneTimeCards.length, 1);
});

test("swap, privacy mode: same-amount payments run side by side, and reconcile reads each one-time card", { skip }, async () => {
  const s = await setup({}, { privacy: true });
  const now = () => new Date().toISOString().replace("Z", "");
  s.filler.next = { outcome: "error", submitted: true, detail: "timeout" };
  // A normal user would get a 409 "another $10 payment is still being confirmed" for the second one.
  const a = await s.swap.pay(s.p, req({ idempotencyKey: "a" }));
  const b = await s.swap.pay(s.p, req({ idempotencyKey: "b" }));
  assert.equal(a.status, "processing");
  assert.equal(b.status, "processing");
  assert.equal(s.oneTimeCards.length, 2);
  await s.age(90_000);
  // Each card shows its own authorization; the one on the user's own card is not either payment's.
  s.txns.push({ cardId: s.oneTimeCards[0], transactionType: "Authorization", transactionStatus: "Approved", transactionAmount: 10, transactionReference: "tx-a", transactionTime: now() });
  s.txns.push({ cardId: s.oneTimeCards[1], transactionType: "Authorization", transactionStatus: "Declined", transactionAmount: 10, transactionReference: "tx-b", transactionTime: now() });
  s.txns.push({ cardId: s.p.cardId, transactionType: "Authorization", transactionStatus: "Approved", transactionAmount: 10, transactionReference: "tx-other", transactionTime: now() });
  await s.swap.reconcile();
  assert.equal((await s.swap.get(s.p, a.swapId)).status, "paid");
  assert.equal((await s.swap.get(s.p, b.swapId)).status, "failed");
  assert.equal(await s.balance(), 1_000, "one payment stands, one was refunded");
});

test("swap, privacy mode: no one-time card means nothing is typed and nothing is charged", { skip }, async () => {
  const s = await setup({}, { privacy: true });
  // Swap in a card service that cannot make cards.
  (s.app as any).d.cardIssuer = { ...(s.app as any).d.cardIssuer, issueOneTime: async () => { throw new MidenApiError("POST", "/api/v2/cards/issue-lite", 400, JSON.stringify({ responseCode: "111", responseMessage: "Maximum Number of Cards Per customer Limit 3 Exceeded" })); } };
  const r = await s.swap.pay(s.p, req());
  assert.equal(r.status, "failed");
  assert.match(r.payment!.reason!, /Limit 3 Exceeded/);
  assert.equal(s.filler.calls.length, 0);
  assert.equal(await s.balance(), 2_000);
});

// ---------- unfamiliar checkouts: open hosts and test shops ----------

const SHOP = "https://shop.example.com/checkout/o_1";

test("swap, open hosts: off by default; on, any public https page is paid only with a one-time card, never the user's own", { skip }, async () => {
  const closed = await setup();
  await assert.rejects(closed.swap.pay(closed.p, req({ checkoutUrl: SHOP })), /not supported/);

  const s = await setup({ openHosts: true });
  s.filler.expectPan = ONE_TIME_PAN;
  // Not in privacy mode, and the user's own card is not even needed on file.
  await s.vault.discard(s.p.cardId, "test");
  const r = await s.swap.pay(s.p, req({ checkoutUrl: SHOP }));
  assert.equal(r.status, "paid");
  assert.equal(s.oneTimeCards.length, 1, "a one-time card was made for this payment");
  assert.deepEqual(s.vault.audit.filter((x) => x.action === "reveal").map((x) => x.cardId), [s.oneTimeCards[0]]);
  assert.equal(await s.vault.has(s.oneTimeCards[0]!), false, "and discarded afterwards");
  assert.equal(s.filler.calls[0]!.watch, undefined, "a real card's page is never watched");
  assert.equal(await s.balance(), 1_000);

  // An allowlisted host still uses the user's own card.
  s.filler.expectPan = TEST_CARD.pan;
  await s.vault.put(s.p.cardId, card());
  assert.equal((await s.swap.pay(s.p, req({ idempotencyKey: "k2", amountCents: 500 }))).status, "paid");
  assert.equal(s.oneTimeCards.length, 1);
});

test("swap, open hosts: this machine, private networks and plain http are refused before anything is reserved", { skip }, async () => {
  const s = await setup({ openHosts: true });
  for (const u of ["https://localhost/pay", "https://127.0.0.1:8443/pay", "https://10.0.0.5/pay", "https://169.254.169.254/latest", "https://intranet/pay", "https://[::1]/pay", "http://shop.example.com/pay"]) {
    await assert.rejects(s.swap.pay(s.p, req({ checkoutUrl: u, idempotencyKey: u })), (e: { status?: number }) => e.status === 400, u);
  }
  assert.equal(s.filler.calls.length, 0);
  assert.equal(await s.balance(), 2_000);
});

test("swap, test shops: a test shop's page is paid with the 4242 test card and can be watched; off test-card mode it is refused", { skip }, async () => {
  const feed = new SwapLiveFeed();
  const s = await setup({ stripeTestCard: true, testHosts: ["localhost:8790"] }, { live: feed });
  s.filler.expectPan = "4242424242424242";
  const seen: SwapLiveEvent[] = [];
  feed.subscribe(s.p.agentId, (e) => seen.push(e));
  const r = await s.swap.pay(s.p, req({ checkoutUrl: "http://localhost:8790/shop/ankara/checkout/o_1" }));
  assert.equal(r.status, "paid");
  assert.ok(s.filler.calls[0]!.watch, "the test-card fill gets a viewer");
  assert.equal(seen[0]!.type, "start");
  assert.equal(s.oneTimeCards.length, 0);
  assert.equal(s.vault.audit.filter((x) => x.action === "reveal").length, 0, "the vault is never opened");

  const off = await setup({ testHosts: ["localhost:8790"] });
  await assert.rejects(off.swap.pay(off.p, req({ checkoutUrl: "http://localhost:8790/shop/ankara/checkout/o_1" })), /not supported/);
});
