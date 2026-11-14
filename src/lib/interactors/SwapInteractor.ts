import { randomBytes } from "node:crypto";
import type { SwapRepository } from "../../domain/repositories/SwapRepository.js";
import type { CheckoutSwap } from "../../domain/types/Entities.js";
import type { CardTransaction } from "../../domain/interfaces/CardIssuing.js";
import type { CardVault } from "../../adapters/cardVault/CardVault.js";
import { SWAP_KEY_PREFIX, type AgentPrincipal, type ChargeOutcome, type Charger, type PayRequest, type SpendView } from "./CardholderInteractor.js";
import { scrub, type CardDetails, type CheckoutFiller, type FillResult } from "../../adapters/checkoutFillers/CheckoutFiller.js";
import type { SwapLiveFeed } from "../services/SwapLiveFeed.js";
import { isPrivateHost } from "../../adapters/checkoutFillers/formScan.js";
import { AgentCardsError, badRequestError, conflictError, forbiddenError, notFoundError } from "../../errors.js";

/**
 * Checkout swap: an agent pays a third-party hosted checkout (Stripe Checkout) and our server swaps in the
 * owner's real card. The agent sends a URL and the price it agreed to; it never sees the card.
 *
 *   validate (host allowlist, hard cap) -> CardholderInteractor.pay under checkout:swap:<id>  (limits, balance, ledger debit)
 *     -> charge: vault.reveal (audited, purpose checkout:<id>) -> filler checks the page total, types the card, pays
 *     -> details scrubbed in a finally, whatever happened
 *
 * Charge outcomes: the page confirmed -> approved. Nothing was submitted, or the page showed a decline -> refused
 * (the debit is undone). Submitted with no clear answer (3-D Secure, a bot check after submit, timeout) -> unknown:
 * the money stays held and reconcile() matches the card's own Authorization by amount and time (a real checkout's
 * merchant id is the acquirer's, so it cannot tell payments apart). Two open swaps that could own one Authorization go
 * to a person rather than guessing. A challenge is never
 * retried automatically; a new attempt needs a new idempotency key from the agent.
 */

export interface SwapConfig {
  /** Off unless switched on (SWAP_ENABLED=1). */
  enabled: boolean;
  /** Hard cap per swap in cents. $10 until the live test passes. */
  maxAmountCents: number;
  /** Exact hosts allowed (https). Default: checkout.stripe.com and buy.stripe.com. */
  allowedHosts: string[];
  /** Hosts allowed over plain http (local fixture only). */
  insecureHosts?: string[];
  /** Receipt email typed into the page when the owner's email cannot be used. */
  fallbackEmail?: string;
  /**
   * Sandbox only (SWAP_STRIPE_TEST_CARD=1): a Stripe TEST-mode link (cs_test_..., buy.stripe.com/test_...) is paid with
   * Stripe's public 4242 test card instead of the vaulted card, which a test page would refuse. The vault is not
   * opened, and there is no card authorization to match afterwards. Live links are never affected.
   */
  stripeTestCard?: boolean;
  /**
   * Sandbox only, with stripeTestCard (SWAP_TEST_HOSTS): exact hosts of test shops (e.g. the demo's local shop) whose
   * checkouts are paid with the same 4242 test card. Allowed over http or https.
   */
  testHosts?: string[];
  /**
   * SWAP_OPEN_HOSTS=1: a public https checkout on a host that is not in allowedHosts may be paid too, but only ever with a
   * one-time card holding exactly the agreed amount (made for the payment, whether or not the owner is in privacy
   * mode). Hosts naming this machine or a private network are always refused.
   */
  openHosts?: boolean;
}

export interface SwapContext {
  swaps: SwapRepository;
  app: {
    pay(p: AgentPrincipal, req: PayRequest, opts: { internal: true; charge: Charger }): Promise<SpendView>;
    resolveSwapSpend(spendId: string, out: { status: "approved"; auth?: string } | { status: "voided"; reason: string }): Promise<boolean>;
    noteSpend(spendId: string, reason: string): Promise<void>;
    /** The user's own card, or in privacy mode a one-time card made for this payment. */
    chargeCardFor(p: AgentPrincipal, spendId: string, amountCents: number, opts: { needDetails: boolean; forceOneTime?: boolean }): Promise<string>;
    privacyMode(userId: string): Promise<boolean>;
  };
  vault: Pick<CardVault, "reveal" | "has" | "discard">;
  filler: CheckoutFiller;
  lifecycle: { transactions(cardId: string, type?: string, pageSize?: number): Promise<CardTransaction[]> };
  config: SwapConfig;
  /** Live view for test-card swaps only (see SwapLiveFeed). */
  live?: SwapLiveFeed;
  now?: () => Date;
  log?: (msg: string) => void;
}

export type SwapStatus = "pending" | "filling" | "processing" | "paid" | "failed" | "challenge" | "needs_review";

export interface SwapRequest {
  checkoutUrl: string;
  /** The price the agent agreed to; the page total must match exactly or nothing is typed. */
  amountCents: number;
  merchant: string;
  mcc?: string;
  /** Required: same key + same swap = the same result, never a second payment. */
  idempotencyKey: string;
}

export interface SwapView {
  swapId: string;
  status: SwapStatus;
  amountCents: number;
  currency: "USD";
  merchant: string;
  checkoutHost: string;
  /** What the checkout page did (succeeded, declined, amount_mismatch, captcha, three_ds, unsupported_page, error). */
  outcome: string | null;
  detail: string | null;
  payment: { paymentId: string; status: SpendView["status"]; reason: string | null } | null;
  /** Set when a person is looking at this payment (e.g. the card network saw a different merchant category). */
  underReview: string | null;
  createdAt: string;
}

export const DEFAULT_SWAP_CAP_CENTS = 1_000;
/** Stripe Checkout sessions and Stripe Payment Links. */
export const DEFAULT_SWAP_HOSTS = ["checkout.stripe.com", "buy.stripe.com"];
/** A swap left open this long is checked against the card's transactions. */
const RECONCILE_AFTER_MS = 60_000;
/** After this long with no matching card transaction, a person must look (the money stays held). */
const GIVE_UP_AFTER_MS = 30 * 60_000;
/** A card Authorization this far before the swap started cannot be its charge (clock skew allowance). */
const MATCH_SKEW_MS = 2 * 60_000;

/**
 * A Stripe test-mode Checkout session (checkout.stripe.com, one session id, last path segment cs_test_...) or Payment Link
 * (buy.stripe.com, first segment test_...): only Stripe's test cards can pay it, and no money moves. Checked against
 * Stripe's own hosts, not config.allowedHosts; pay() still requires the host to be allowed as well.
 */
export function isStripeTestUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const segs = u.pathname.split("/").filter(Boolean);
  // Exactly one session id (cs_...) and it is the last segment and a test one: /cs_live_a/cs_test_x is not a test link.
  if (u.host === "checkout.stripe.com") return segs.filter((x) => x.startsWith("cs_")).length === 1 && segs[segs.length - 1]!.startsWith("cs_test_");
  if (u.host === "buy.stripe.com") return segs.length > 0 && segs[0]!.startsWith("test_");
  return false;
}
/** Stripe's public test card (docs.stripe.com/testing). Not anyone's card. */
const stripeTestCard = (): CardDetails => ({
  pan: "4242424242424242", cvv: "123", expMonth: 12, expYear: new Date().getUTCFullYear() + 3, nameOnCard: "Agent Card Test", billingZip: "94107",
  billingAddress: { line1: "510 Townsend St", city: "San Francisco", state: "CA", country: "US" },
});
/** card_txn_ref for a swap paid with the Stripe test card: there is no card authorization to claim. */
const TEST_CARD_REF = "stripe-test-card:";
/** charge_card_id of a swap paid with the Stripe test card, so reconcile never matches it to a real authorization. */
const TEST_CARD_ID = "stripe-test-card";

const newId = () => `sw_${randomBytes(12).toString("hex")}`;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function swapConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SwapConfig {
  const cap = env.SWAP_MAX_CENTS === undefined ? DEFAULT_SWAP_CAP_CENTS : Number(env.SWAP_MAX_CENTS);
  if (!Number.isSafeInteger(cap) || cap <= 0) throw new Error("SWAP_MAX_CENTS must be a positive whole number of cents");
  const list = (v?: string) => (v ? v.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean) : []);
  return {
    enabled: env.SWAP_ENABLED === "1",
    maxAmountCents: cap,
    allowedHosts: env.SWAP_ALLOWED_HOSTS ? list(env.SWAP_ALLOWED_HOSTS) : DEFAULT_SWAP_HOSTS,
    insecureHosts: list(env.SWAP_INSECURE_HOSTS),
    fallbackEmail: env.SWAP_RECEIPT_EMAIL,
    stripeTestCard: env.SWAP_STRIPE_TEST_CARD === "1",
    testHosts: list(env.SWAP_TEST_HOSTS),
    openHosts: env.SWAP_OPEN_HOSTS === "1",
  };
}

export class SwapInteractor {
  private readonly now: () => Date;
  private readonly log: (msg: string) => void;
  /** One browser fill at a time in this process (one shared laptop, one Chromium). */
  private fillQueue: Promise<unknown> = Promise.resolve();
  private readonly running = new Map<string, Promise<SwapView>>();
  private reconcileRun: Promise<void> | undefined;

  constructor(private readonly d: SwapContext) {
    this.now = d.now ?? (() => new Date());
    this.log = d.log ?? (() => undefined);
  }

  async pay(p: AgentPrincipal, req: SwapRequest): Promise<SwapView> {
    const r = this.validate(req);
    // Fail cleanly, before anything is reserved, when there is no card to swap in. A test link in test-card mode needs
    // none, and an open host gets a one-time card of its own.
    const { testCard, oneTime } = this.cardFor(r.url.href);
    if (!testCard && !oneTime && !(await this.d.vault.has(p.cardId))) {
      throw conflictError("this card's details are not on file, so it cannot pay hosted checkouts; the owner needs to have them captured again");
    }
    await this.insertOrBusy(p, r);
    const row = (await this.d.swaps.findByKey(p.cardId, p.agentId, r.idempotencyKey))!;
    if (row.checkoutUrl !== r.url.href || row.amountCents !== r.amountCents || row.merchant !== r.merchant || (row.mcc ?? undefined) !== r.mcc) {
      throw conflictError("that idempotency key was already used for a different checkout payment");
    }
    // Calling pay again under the same spend key never charges twice (CardholderInteractor returns the first result),
    // so a pending row (crash, or a concurrent call) can always be driven forward safely.
    if (row.status !== "pending") return this.view(row);
    const swapId = row.swapId;
    const inflight = this.running.get(swapId);
    if (inflight) return inflight;
    const run = this.drive(p, row).finally(() => this.running.delete(swapId));
    this.running.set(swapId, run);
    return run;
  }

  async get(p: AgentPrincipal, swapId: string): Promise<SwapView> {
    const row = await this.d.swaps.findForAgent(swapId, p.cardId, p.agentId);
    if (!row) throw notFoundError("checkout payment not found");
    return this.view(row);
  }

  async list(p: AgentPrincipal, limit = 20): Promise<SwapView[]> {
    const rows = await this.d.swaps.listForAgent(p.cardId, p.agentId, Math.min(Math.max(limit, 1), 100));
    return Promise.all(rows.map((r) => this.view(r)));
  }

  private validate(req: SwapRequest): { url: URL; amountCents: number; merchant: string; mcc?: string; idempotencyKey: string } {
    const c = this.d.config;
    if (!c.enabled) throw forbiddenError("paying hosted checkouts is not enabled on this server");
    const amountCents = req.amountCents;
    if (typeof amountCents !== "number" || !Number.isSafeInteger(amountCents) || amountCents <= 0) throw badRequestError("amount must be a positive whole number of cents");
    if (amountCents > c.maxAmountCents) throw badRequestError(`hosted checkout payments are capped at ${usd(c.maxAmountCents)} for now`);
    if (typeof req.merchant !== "string" || !req.merchant.trim() || req.merchant.length > 80) throw badRequestError("merchant is required (at most 80 characters)");
    const mcc = req.mcc === undefined || req.mcc === null || req.mcc === "" ? undefined : String(req.mcc);
    if (mcc !== undefined && !/^\d{4}$/.test(mcc)) throw badRequestError("mcc must be 4 digits");
    if (typeof req.idempotencyKey !== "string" || !req.idempotencyKey.trim() || req.idempotencyKey.length > 100) {
      throw badRequestError("idempotencyKey is required: a checkout payment must never be sent twice by accident");
    }
    let url: URL;
    try {
      url = new URL(String(req.checkoutUrl));
    } catch {
      throw badRequestError("checkoutUrl is not a valid URL");
    }
    const host = url.host.toLowerCase();
    const secureOk = url.protocol === "https:" && c.allowedHosts.includes(host);
    const insecureOk = url.protocol === "http:" && (c.insecureHosts ?? []).includes(host);
    const testOk = Boolean(c.stripeTestCard) && /^https?:$/.test(url.protocol) && (c.testHosts ?? []).includes(host);
    const openOk = Boolean(c.openHosts) && url.protocol === "https:" && !isPrivateHost(host);
    if (!secureOk && !insecureOk && !testOk && !openOk) {
      throw badRequestError(c.openHosts
        ? `checkout host ${host} is not supported (only public https checkout pages can be paid)`
        : `checkout host ${host} is not supported (allowed: ${c.allowedHosts.join(", ")})`);
    }
    if (url.username || url.password) throw badRequestError("checkoutUrl must not contain credentials");
    return { url, amountCents, merchant: req.merchant.trim(), mcc, idempotencyKey: req.idempotencyKey.trim() };
  }

  /**
   * Which card a checkout URL is paid with: Stripe's test card (a Stripe test link, or a test shop, in test-card mode),
   * a one-time card (a host that is not on the allowlist: SWAP_OPEN_HOSTS), or else the vaulted card (or, in privacy
   * mode, a one-time card anyway).
   */
  private cardFor(raw: string): { testCard: boolean; oneTime: boolean } {
    const c = this.d.config;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { testCard: false, oneTime: true };
    }
    const host = url.host.toLowerCase();
    const testCard = Boolean(c.stripeTestCard) && (isStripeTestUrl(raw) || (c.testHosts ?? []).includes(host));
    const vetted = (url.protocol === "https:" && c.allowedHosts.includes(host)) || (url.protocol === "http:" && (c.insecureHosts ?? []).includes(host));
    return { testCard, oneTime: !testCard && !vetted };
  }

  private async drive(p: AgentPrincipal, row: CheckoutSwap): Promise<SwapView> {
    const swapId = row.swapId;
    const amountCents = row.amountCents;
    let fill: FillResult | undefined;
    const { testCard, oneTime } = this.cardFor(row.checkoutUrl);
    const outcomeOf = (f: FillResult): ChargeOutcome => {
      if (f.outcome === "succeeded") return { kind: "approved" };
      if (f.outcome === "declined") return { kind: "refused", reason: "card declined at the checkout" };
      if (!f.submitted) return { kind: "refused", reason: refusedReason(f) };
      return { kind: "unknown", reason: "the checkout gave no clear answer after the card was submitted; the money is held while we check the card" };
    };
    const charge: Charger = (spendId) => this.serialized(async (): Promise<ChargeOutcome> => {
      await this.d.swaps.markFilling(swapId, spendId);
      let card: CardDetails | null = null;
      let chargeCardId = p.cardId;
      try {
        if (testCard) {
          this.log(`swap ${swapId}: test link or test shop, paying with Stripe's test card (the vault is not opened)`);
          await this.d.swaps.setChargeCard(swapId, TEST_CARD_ID);
          card = stripeTestCard();
        } else {
          // As late as possible: after the debit, right before the page. In privacy mode this is where the one-time
          // card is made, so a payment that never gets this far never costs a card.
          // An open (not allowlisted) host always gets a one-time card holding exactly this amount.
          chargeCardId = await this.d.app.chargeCardFor(p, spendId, amountCents, { needDetails: true, forceOneTime: oneTime });
          if (chargeCardId !== p.cardId) {
            await this.d.swaps.setChargeCard(swapId, chargeCardId);
          }
          card = await this.d.vault.reveal(chargeCardId, `checkout:${swapId}`);
          if (!card) {
            fill = { outcome: "error", submitted: false, detail: "card details not on file" };
            return { kind: "refused", reason: "this card's details are not on file; nothing was charged" };
          }
        }
        // The live view is for Stripe's public test card only: with a real card nothing from the page is captured.
        const live = testCard ? this.d.live : undefined;
        live?.publish(p.agentId, { type: "start", swapId, merchant: row.merchant, amountCents, url: row.checkoutUrl });
        const watch = live && {
          step: (label: string) => live.publish(p.agentId, { type: "step", swapId, label }),
          frame: (jpeg: string) => live.publish(p.agentId, { type: "frame", swapId, jpeg }),
        };
        fill = await this.d.filler.fill({ url: row.checkoutUrl, expectedAmountCents: amountCents, card, email: await this.receiptEmail(p), ...(watch ? { watch } : {}) });
        live?.publish(p.agentId, { type: "end", swapId, outcome: fill.outcome });
      } catch (e) {
        // The filler reports its own errors; this is the vault or something unexpected, before any submit.
        fill = { outcome: "error", submitted: false, detail: errText(e).slice(0, 200) };
        // AgentCardsError messages are written for the caller (e.g. why a one-time card could not be made).
        return { kind: "refused", reason: e instanceof AgentCardsError ? e.message : "could not start the checkout; nothing was charged" };
      } finally {
        scrub(card);
        card = null;
        // A one-time card is single use: once the page has had it, nothing here needs its details again.
        if (chargeCardId !== p.cardId) await this.d.vault.discard(chargeCardId, `checkout:${swapId}:done`).catch((e) => this.log(`swap ${swapId}: could not discard the one-time card's details: ${errText(e)}`));
      }
      await this.d.swaps.recordFill(swapId, { outcome: fill.outcome, detail: fill.detail ?? null, submitted: fill.submitted });
      this.log(`swap ${swapId}: ${fill.outcome}${fill.submitted ? " (submitted)" : ""}`);
      return outcomeOf(fill);
    });

    let spend: SpendView;
    try {
      spend = await this.d.app.pay(p, { amountCents, merchant: row.merchant, mcc: row.mcc ?? undefined, idempotencyKey: `${SWAP_KEY_PREFIX}${swapId}` }, { internal: true, charge });
    } catch (e) {
      // Nothing was reserved (a 4xx from pay), so this attempt is over.
      await this.d.swaps.failIfOpen(swapId, errText(e).slice(0, 200));
      throw e;
    }
    const status: SwapStatus =
      spend.status === "approved" ? "paid"
      : fill && (fill.outcome === "captcha" || fill.outcome === "three_ds") ? "challenge"
      : spend.status === "processing" ? "processing"
      : "failed";
    const detail = fill ? undefined : spend.reason ?? undefined;
    const updated = await this.d.swaps.finish(swapId, {
      status,
      spendId: spend.spendId,
      ...(detail !== undefined ? { detail } : {}),
      ...(testCard ? { cardTxnRefIfPaid: `${TEST_CARD_REF}${swapId}` } : {}),
    });
    return this.view(updated);
  }

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.fillQueue.then(fn, fn);
    this.fillQueue = run.catch(() => undefined);
    return run;
  }

  private async receiptEmail(p: AgentPrincipal): Promise<string> {
    const email = (await this.d.swaps.ownerEmail(p.cardId)) ?? this.d.config.fallbackEmail;
    if (!email) throw new Error("no receipt email for this card");
    return email;
  }

  /**
   * Settles swaps whose charge state was unknown (3-D Secure, timeout, crash) from the card's Authorization list:
   * exactly one unclaimed Authorization of the same amount, from the swap's start onwards. Ambiguity or silence past
   * GIVE_UP_AFTER_MS goes to a person (needs_review); money is never refunded on absence of evidence.
   */
  reconcile(): Promise<void> {
    this.reconcileRun ??= this.doReconcile().finally(() => (this.reconcileRun = undefined));
    return this.reconcileRun;
  }

  private async doReconcile(): Promise<void> {
    const before = new Date(this.now().getTime() - RECONCILE_AFTER_MS);
    // A challenge is open only while its money is held; one whose spend was voided (stopped before submit) is final.
    const rows = await this.d.swaps.openForReconcile(before, 100);
    const lists = new Map<string, Promise<CardTransaction[]>>();
    for (const s of rows) {
      if (this.running.has(s.swapId)) continue;
      await this.reconcileOne(s, lists).catch((e) => this.log(`swap reconcile ${s.swapId}: ${errText(e)}`));
    }
    // Paid on the page: confirm on the card, and learn the real merchant category.
    const paid = await this.d.swaps.paidUnconfirmed(before, 100);
    for (const s of paid) await this.confirmPaid(s, lists).catch((e) => this.log(`swap confirm ${s.swapId}: ${errText(e)}`));
  }

  /** Unclaimed Authorizations on the swap's card that could be its charge: same amount, not before it started. */
  private async candidates(s: CheckoutSwap, lists: Map<string, Promise<CardTransaction[]>>): Promise<CardTransaction[]> {
    // Paid with Stripe's test card: no card was charged, so no real authorization may ever be claimed for it.
    if (s.chargeCardId === TEST_CARD_ID) return [];
    const onCard = s.chargeCardId ?? s.cardId;
    if (!lists.has(onCard)) lists.set(onCard, this.d.lifecycle.transactions(onCard, "Authorization", 100));
    const claimed = await this.d.swaps.claimedTxnRefs(s.cardId);
    const from = s.createdAt.getTime() - MATCH_SKEW_MS;
    const amount = s.amountCents;
    return (await lists.get(onCard)!).filter((t) => {
      const ref = txnRef(t);
      const at = parseCardTime(t.transactionTime);
      return ref !== undefined && !claimed.has(ref) && Math.round((t.transactionAmount ?? NaN) * 100) === amount && at !== undefined && at >= from;
    });
  }

  /**
   * Writes the swap row, unless another swap of the same amount on the same card is still in flight: reconcile could
   * not tell their card authorizations apart (see hasRival), so the agent waits a minute instead. A retry under an
   * existing key is never refused. The advisory lock makes check-and-insert atomic per card and amount.
   */
  private async insertOrBusy(p: AgentPrincipal, r: ReturnType<SwapInteractor["validate"]>): Promise<void> {
    const inserted = await this.d.swaps.insertUnlessBusy(
      {
        swapId: newId(), cardId: p.cardId, agentId: p.agentId, idempotencyKey: r.idempotencyKey,
        checkoutUrl: r.url.href, checkoutHost: r.url.host, amountCents: r.amountCents, merchant: r.merchant, mcc: r.mcc ?? null,
      },
      {
        busySince: new Date(this.now().getTime() - GIVE_UP_AFTER_MS),
        // Privacy mode charges a card of its own per payment, so same-amount payments cannot be confused with each other.
        skipBusyCheck: async () => this.cardFor(r.url.href).oneTime || (await this.d.app.privacyMode(p.userId)),
      },
    );
    if (!inserted) {
      throw conflictError(`another ${usd(r.amountCents)} checkout payment on this card is still being confirmed; nothing was charged. Try again in a minute`);
    }
  }

  /**
   * Another unsettled swap on the same card, for the same amount, that a card transaction at `at` could also belong
   * to. A real checkout's merchant id is the acquirer's, the same for every payment to that merchant, so amount and
   * time are all we can match on; when two swaps fit, neither settles on its own.
   */
  private async hasRival(s: CheckoutSwap, at: number | undefined): Promise<boolean> {
    // A one-time card carries only this payment's authorization: no other payment can be mistaken for it.
    if (s.chargeCardId) return false;
    if (at === undefined) return true;
    return this.d.swaps.hasRival(s, { from: new Date(at - GIVE_UP_AFTER_MS), to: new Date(at + MATCH_SKEW_MS) });
  }

  /** Claims a card transaction for a swap (unique: one transaction settles one swap) and records its MCC. */
  private async claim(s: CheckoutSwap, t: CardTransaction): Promise<boolean> {
    const note = mccReview(s.mcc, t.merchantMcc);
    // Any failure (above all: the transaction is already claimed by another swap, card_txn_ref is unique) means not claimed.
    const claimed = await this.d.swaps.claimCardTxn(s.swapId, txnRef(t)!, t.merchantMcc ?? null, note).catch(() => false);
    if (claimed && note) this.log(`swap ${s.swapId}: ${note}`);
    return claimed;
  }

  private async confirmPaid(s: CheckoutSwap, lists: Map<string, Promise<CardTransaction[]>>): Promise<void> {
    const approved = (await this.candidates(s, lists)).filter((t) => /^(approved|successful|settled)$/i.test(t.transactionStatus ?? ""));
    const review = (note: string) => {
      this.log(`swap ${s.swapId}: ${note}`);
      return this.d.swaps.flagForReview(s.swapId, note);
    };
    if (approved.length === 1) {
      if (await this.hasRival(s, parseCardTime(approved[0]!.transactionTime))) return void (await review("another open payment of the same amount on this card could own the card authorization"));
      return void (await this.claim(s, approved[0]!));
    }
    if (approved.length > 1) return void (await review(`${approved.length} card authorizations could be this payment`));
    if (this.now().getTime() - s.createdAt.getTime() > GIVE_UP_AFTER_MS) {
      await review("the checkout page said paid, but the card shows no matching authorization");
    }
  }

  private async reconcileOne(s: CheckoutSwap, lists: Map<string, Promise<CardTransaction[]>>): Promise<void> {
    const swapId = s.swapId;
    const set = (status: SwapStatus, detail?: string) => this.d.swaps.setStatus(swapId, status, detail);
    const spend = await this.d.swaps.findSpend(s.cardId, s.agentId, `${SWAP_KEY_PREFIX}${swapId}`);
    if (!spend) {
      // No spend row: pay never got as far as reserving, so nothing can have been charged.
      await set("failed", "interrupted before payment; nothing was charged");
      return;
    }
    if (spend.status === "approved") return void (await set("paid"));
    if (spend.status === "declined" || spend.status === "voided") return void (await set(s.status === "challenge" ? "challenge" : "failed"));

    const candidates = await this.candidates(s, lists);
    const amount = s.amountCents;
    const age = this.now().getTime() - s.createdAt.getTime();
    if (candidates.length > 1) {
      const note = `needs review: ${candidates.length} card authorizations of ${usd(amount)} could be this payment; the money is held`;
      await set("needs_review", note);
      await this.d.app.noteSpend(spend.spendId, note);
      this.log(`swap ${swapId}: ${note}`);
      return;
    }
    const t = candidates[0];
    if (!t) {
      if (age > GIVE_UP_AFTER_MS) {
        const note = "needs review: the card shows no authorization for this payment yet; the money is held";
        await set("needs_review", note);
        await this.d.app.noteSpend(spend.spendId, note);
        this.log(`swap ${swapId}: ${note}`);
      }
      return;
    }
    if (await this.hasRival(s, parseCardTime(t.transactionTime))) {
      const note = `needs review: another open payment of ${usd(amount)} on this card could own the card authorization; the money is held`;
      await set("needs_review", note);
      await this.d.app.noteSpend(spend.spendId, note);
      this.log(`swap ${swapId}: ${note}`);
      return;
    }
    const status = t.transactionStatus ?? "";
    if (/^(approved|successful|settled)$/i.test(status)) {
      // Claim first (unique), so one authorization can never settle two swaps.
      if (!(await this.claim(s, t))) return;
      await this.d.app.resolveSwapSpend(spend.spendId, { status: "approved", auth: t.authCode });
      await set("paid", "confirmed on the card");
      this.log(`swap ${swapId}: approved on the card`);
    } else if (/^(declined|failed|reversed)$/i.test(status)) {
      await this.claim(s, t);
      await this.d.app.resolveSwapSpend(spend.spendId, { status: "voided", reason: `card declined (${status})` });
      await set(s.status === "challenge" ? "challenge" : "failed", `card declined (${status})`);
    } else if (age > GIVE_UP_AFTER_MS) {
      const note = `needs review: the card shows status "${status}"; the money is held`;
      await set("needs_review", note);
      await this.d.app.noteSpend(spend.spendId, note);
    }
  }

  private async view(row: CheckoutSwap): Promise<SwapView> {
    const spend = row.spendId ? await this.d.swaps.spendSummary(row.spendId) : undefined;
    return {
      swapId: row.swapId,
      status: row.status,
      amountCents: row.amountCents,
      currency: "USD",
      merchant: row.merchant,
      checkoutHost: row.checkoutHost,
      outcome: row.outcome ?? null,
      detail: row.detail ?? null,
      payment: spend ? { paymentId: spend.spendId, status: spend.status, reason: spend.reason ?? null } : null,
      underReview: row.review ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

function refusedReason(f: FillResult): string {
  switch (f.outcome) {
    case "amount_mismatch": return `the checkout's price is not what you agreed to (${f.detail ?? "different total"}); nothing was charged`;
    case "captcha": return "the checkout showed a bot check, so we stopped; nothing was charged. It will not be retried automatically";
    case "unsupported_page": return `this checkout page is not supported (${f.detail ?? "no card form"}); nothing was charged`;
    default: return `the checkout could not be completed (${f.detail ?? f.outcome}); nothing was charged`;
  }
}

/** A review note when the agent declared one merchant category and the card network saw another. */
const mccReview = (declared: string | null, seen: string | undefined) =>
  declared && seen && declared !== seen ? `merchant category mismatch: declared ${declared}, card network saw ${seen}` : null;

const txnRef = (t: CardTransaction) => t.transactionReference ?? (t.id === undefined ? undefined : String(t.id));

/** Miden shows UTC without a zone suffix ("2026-10-19T14:11:54.689346"). */
export function parseCardTime(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  return Number.isNaN(ms) ? undefined : ms;
}
