import { randomBytes, randomUUID } from "node:crypto";
import { CardProviderBusinessError } from "../../../domain/errors/CardProviderErrors.js";
import type {
  AgentCard, AuthorizationResult, CardIssuerPort, CardLifecyclePort, CardTransaction, CardholderKyc, IndividualKyc,
} from "../../../domain/interfaces/CardIssuing.js";
import type { FundingReceipt, FundingRequest, FundingSource, Stablecoin } from "../../../domain/interfaces/FundingSource.js";
import { SpendTracker } from "../../../lib/services/SpendTracker.js";
import type { SpendPolicy } from "../../../lib/services/spendPolicy.js";
import type { CardVault } from "../../cardVault/CardVault.js";

/** Issues the fake card numbers every payment test suite knows: the Visa test PAN. It never works at a real merchant. */
const TEST_PAN = "4242424242424242";

interface MockCard { balanceCents: number; limit?: number }

/**
 * A card provider that lives in memory, so the project runs with no external accounts: KYC is approved at once,
 * cards are fake, simulated purchases and top-ups move a balance. Everything is lost on restart, so after a restart
 * existing users keep their rows but the provider no longer knows their cards (balance reads then fail, which the
 * dashboard shows as "unknown"). Implements the whole card-issuing port, so it also stands in for a real provider in tests.
 */
export class MockCardProvider implements CardLifecyclePort, CardIssuerPort, FundingSource {
  readonly name = "mock";
  private readonly cards = new Map<string, MockCard>();
  private readonly txs = new Map<string, CardTransaction[]>();
  private readonly kyc = new Map<string, { customerId: string; kycToken: string }>();
  private readonly tracker: SpendTracker;
  private nextTxId = 1;

  constructor(private readonly opts: { vault?: Pick<CardVault, "put" | "has">; now?: () => Date } = {}) {
    this.tracker = new SpendTracker(opts.now);
  }

  private now(): Date { return this.opts.now?.() ?? new Date(); }

  // ----- lifecycle -----

  async submitKyc(reference: string, _kyc: IndividualKyc): Promise<{ kycStatus?: string }> {
    this.kyc.set(reference, { customerId: `mock-cust-${randomUUID()}`, kycToken: randomBytes(16).toString("hex") });
    return { kycStatus: "Approved" };
  }

  async kycStatus(clientReference: string): Promise<{ status: string; customerId?: string; kycToken?: string }> {
    const k = this.kyc.get(clientReference);
    // A user created before a restart has no record here: approve them again rather than lock them out of the sandbox.
    const v = k ?? { customerId: `mock-cust-${clientReference}`, kycToken: `mock-token-${clientReference}` };
    return { status: "Approved", customerId: v.customerId, kycToken: v.kycToken };
  }

  async cardBalance(cardId: string): Promise<number> {
    const c = this.cards.get(cardId);
    if (!c) throw new Error(`mock provider has no card ${cardId}`);
    return c.balanceCents / 100;
  }

  async transactions(cardId: string, type?: string, pageSize = 50): Promise<CardTransaction[]> {
    return (this.txs.get(cardId) ?? []).filter((t) => !type || t.transactionType === type).slice(-pageSize).reverse();
  }

  async simulateAuthorization(
    a: { cardId: string; amountDollars: number; mcc?: string; merchantName?: string; approve?: boolean; mid?: string },
    opts: { idempotencyKey?: string } = {},
  ): Promise<string | undefined> {
    const card = this.cards.get(a.cardId);
    if (!card) throw new CardProviderBusinessError(`mock: unknown card ${a.cardId}`);
    // Like a real network, replaying a key must not charge twice.
    if (opts.idempotencyKey) {
      const seen = (this.txs.get(a.cardId) ?? []).find((t) => t.transactionReference === opts.idempotencyKey);
      if (seen) return seen.authCode;
    }
    const cents = Math.round(a.amountDollars * 100);
    const approved = a.approve !== false && card.balanceCents >= cents;
    const authCode = `mock-auth-${randomBytes(4).toString("hex")}`;
    if (approved) card.balanceCents -= cents;
    this.record(a.cardId, {
      transactionType: "Authorization", transactionStatus: approved ? "Approved" : "Declined",
      transactionAmount: a.amountDollars, merchantName: a.merchantName ?? "Mock Merchant", merchantMcc: a.mcc ?? "5734",
      merchantMid: a.mid, authCode, transactionReference: opts.idempotencyKey,
    });
    if (!approved) throw new CardProviderBusinessError("mock: card declined (insufficient funds)");
    return authCode;
  }

  // ----- issuing -----

  async issue(agentId: string, policy: SpendPolicy, kyc: CardholderKyc, clientReference: string, initialBalanceDollars = 1): Promise<AgentCard> {
    void kyc;
    const id = `mock-card-${clientReference}`;
    if (!this.cards.has(id)) this.cards.set(id, { balanceCents: Math.round(initialBalanceDollars * 100) });
    const detailsCaptured = this.opts.vault ? await this.capture(id) : undefined;
    return { id, agentId, policy, ...(detailsCaptured === undefined ? {} : { detailsCaptured }) };
  }

  async issueOneTime(
    kyc: CardholderKyc, amountCents: number, clientReference: string, opts: { capture: boolean },
  ): Promise<{ cardId: string; lastFour?: string; detailsCaptured: boolean }> {
    void kyc;
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new Error("amount must be a positive whole number of cents");
    const cardId = `mock-lite-${clientReference}`;
    if (!this.cards.has(cardId)) this.cards.set(cardId, { balanceCents: Math.max(amountCents, 100) });
    const detailsCaptured = opts.capture && this.opts.vault ? await this.capture(cardId) : false;
    return { cardId, lastFour: TEST_PAN.slice(-4), detailsCaptured };
  }

  async captureDetails(cardId: string): Promise<boolean> {
    if (!this.opts.vault) throw new Error("no vault configured");
    return this.capture(cardId);
  }

  private async capture(cardId: string): Promise<boolean> {
    const vault = this.opts.vault!;
    if (await vault.has(cardId)) return true;
    const year = this.now().getUTCFullYear() + 3;
    await vault.put(cardId, { pan: TEST_PAN, cvv: "123", expMonth: 12, expYear: year, nameOnCard: "Mock Cardholder" }, { source: "issue" });
    return true;
  }

  // ----- funding -----

  async fund(req: FundingRequest): Promise<FundingReceipt> {
    if (!Number.isInteger(req.amountCents) || req.amountCents <= 0) throw new RangeError(`amountCents must be a positive integer, got ${req.amountCents}`);
    const card = this.cards.get(req.cardId);
    if (!card) throw new CardProviderBusinessError(`mock: unknown card ${req.cardId}`);
    const seen = (this.txs.get(req.cardId) ?? []).find((t) => t.transactionType === "CardFunding" && t.transactionReference === req.idempotencyKey);
    if (seen) return { id: String(seen.id), status: "confirmed" };
    card.balanceCents += req.amountCents;
    const t = this.record(req.cardId, {
      transactionType: "CardFunding", transactionStatus: "Approved", transactionAmount: req.amountCents / 100,
      transactionReference: req.idempotencyKey,
    });
    return { id: String(t.id), status: "confirmed" };
  }

  topUp(card: AgentCard, amountCents: number, asset: Stablecoin, idempotencyKey: string): Promise<FundingReceipt> {
    return this.fund({ cardId: card.id, amountCents, asset, idempotencyKey });
  }

  authorize(card: AgentCard, amountCents: number, mcc?: string): AuthorizationResult {
    return this.tracker.authorize(card, amountCents, mcc);
  }

  private record(cardId: string, t: Omit<CardTransaction, "id" | "cardId" | "transactionTime">): CardTransaction {
    const full: CardTransaction = { ...t, id: this.nextTxId++, cardId, transactionTime: this.now().toISOString().replace("Z", "") };
    const list = this.txs.get(cardId) ?? [];
    list.push(full);
    this.txs.set(cardId, list);
    return full;
  }
}
