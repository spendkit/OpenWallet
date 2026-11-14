import { createHash, randomBytes } from "node:crypto";
import type { AgentWallets } from "../services/AgentWallets.js";
import type { DepositAddressRepository } from "../../domain/repositories/DepositAddressRepository.js";
import type { AgentRepository } from "../../domain/repositories/AgentRepository.js";
import type { CardRepository } from "../../domain/repositories/CardRepository.js";
import type { FundingRepository } from "../../domain/repositories/FundingRepository.js";
import type { OneTimeCardRepository } from "../../domain/repositories/OneTimeCardRepository.js";
import type { SpendRepository } from "../../domain/repositories/SpendRepository.js";
import type { UserRepository } from "../../domain/repositories/UserRepository.js";
import type { Agent, Card, Spend } from "../../domain/types/Entities.js";
import type { OpenSpendResult } from "../../domain/repositories/SpendRepository.js";
import type { FundingStatus } from "../../domain/repositories/FundingRepository.js";
import type { OneTimeCardStatus } from "../../domain/repositories/OneTimeCardRepository.js";
import { CardProviderApiError, DuplicateReferenceError, isDefiniteRefusal, providerMessage } from "../../domain/errors/CardProviderErrors.js";
import type { CardIssuerPort, CardLifecyclePort, CardTransaction, IndividualKyc } from "../../domain/interfaces/CardIssuing.js";
import { evaluate, type SpendPolicy } from "../services/spendPolicy.js";
import { capPolicy, type Tier, type TierLimits } from "../services/tiers.js";
import type { FundingSource } from "../../domain/interfaces/FundingSource.js";
import { accounts, LedgerError, type Ledger, type LedgerTransaction } from "../services/Ledger.js";
import { parseSimDeposit, SIM_DEPOSIT_PREFIX } from "../../adapters/deposits/simDeposit.js";
import { AgentCardsError, badGatewayError, badRequestError, conflictError, forbiddenError, notFoundError, tooManyRequestsError, unavailableError, unprocessableError } from "../../errors.js";

export interface CardholderContext {
  users: UserRepository;
  cards: CardRepository;
  agents: AgentRepository;
  spends: SpendRepository;
  fundings: FundingRepository;
  oneTimeCards: OneTimeCardRepository;
  ledger: Ledger;
  lifecycle: CardLifecyclePort;
  cardIssuer: Pick<CardIssuerPort, "issue" | "issueOneTime">;
  funding: FundingSource;
  wallets: AgentWallets;
  addresses: DepositAddressRepository;
  /**
   * The deposit-address provider: the address for a unique index. Our HD wallet today (sync); a custody
   * provider would call its API here (hence async), keyed by the same index.
   */
  deriveAddress: (index: number) => string | Promise<string>;
  tiers: Record<Tier, TierLimits>;
  /** Ledger chain label for real deposits, e.g. "base-sepolia". */
  chain: string;
  /** Networks a user may send USDC on, shown on the dashboard. Default: the chain plus Ethereum Sepolia (both watched). */
  depositNetworks?: string[];
  /** How deposits are detected, for the dashboard's wording: Circle webhooks or our chain pollers. */
  depositRail?: "circle" | "chain";
  /** Miden sandbox: agents pay through Miden's simulated authorization. */
  sandbox: boolean;
  /** Sandbox only, and only when explicitly switched on (ALLOW_SIMULATED_DEPOSITS=1): fake deposits. */
  simulatedDeposits?: boolean;
  now?: () => Date;
  log?: (msg: string) => void;
  /** Told about things a developer may want a webhook for (kyc.updated, card.issued, funding.completed, spend.settled). Never throws into the money path. */
  onEvent?: (userId: string, type: string, data: Record<string, unknown>) => Promise<void>;
}

export interface AgentPrincipal {
  cardId: string;
  agentId: string;
  name: string;
  userId: string;
}

export interface PayRequest {
  amountCents: number;
  merchant: string;
  mcc?: string;
  /** Same key + same payment = the same result, never a second charge. */
  idempotencyKey?: string;
}

export interface SpendView {
  spendId: string;
  amountCents: number;
  merchant: string;
  mcc: string | null;
  status: "processing" | "approved" | "declined" | "voided";
  reason: string | null;
  createdAt: string;
}

/** Miden's minimum useful top-up for us; smaller holding balances wait for more deposits. */
const MIN_FUNDING_CENTS = 100;
const ONE_TIME_MIN_CENTS = 100;
const ONE_TIME_MAX_PER_DAY = 50;
/** A payment still unanswered this long after it started is checked against the card's transactions. */
const RECONCILE_AFTER_MS = 60_000;
/** A payment the card network has no record of after this long is flagged for review (never refunded automatically). */
const GIVE_UP_AFTER_MS = 10 * 60_000;
/** Miden's Reference idempotency lasts 24h: past this, a reserved top-up is looked up, never re-sent. */
const RESEND_WINDOW_MS = 20 * 3_600_000;
/** Spend keys reserved for checkout payments; agents cannot use them. */
export const INTERNAL_KEY_PREFIX = "checkout:";
/** Spend keys of checkout-swap payments (src/checkout-swap): charged by filling a hosted checkout, reconciled by SwapInteractor. */
export const SWAP_KEY_PREFIX = "checkout:swap:";

/**
 * How an internal caller charges the card instead of Miden's simulated authorization. Called once, after the
 * agent's limits passed and its money is debited. "refused" means nothing was charged (the debit is undone);
 * "unknown" means we cannot tell (the money stays held and the caller's own reconcile settles it via resolveSpend).
 */
export type ChargeOutcome = { kind: "approved"; auth?: string } | { kind: "refused"; reason: string } | { kind: "unknown"; reason: string };
export type Charger = (spendId: string) => Promise<ChargeOutcome>;
const ID_TYPES = new Set(["PASSPORT", "NATIONAL_ID", "DRIVERS_LICENSE", "VOTERS_CARD"]);

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
const newId = (prefix: string, bytes = 6) => `${prefix}_${randomBytes(bytes).toString("hex")}`;
const newToken = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
/**
 * Per-spend merchant id for Miden's simulated authorization. It comes back as `merchantMid` on the card's
 * Authorization transaction, so a payment whose answer was lost can be found exactly.
 */
export const midFor = (spendId: string) => `9${(BigInt(`0x${createHash("sha256").update(spendId).digest("hex").slice(0, 15)}`) % 10n ** 14n).toString().padStart(14, "0")}`;

function requireCents(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) throw badRequestError(`${what} must be a positive whole number of cents`);
  return v;
}

function requireText(v: unknown, what: string, max = 200): string {
  if (typeof v !== "string" || !v.trim()) throw badRequestError(`${what} is required`);
  if (v.length > max) throw badRequestError(`${what} is too long`);
  return v.trim();
}

/**
 * The sandbox service: a user signs up, passes Miden Card KYC, gets one card and a USDC deposit address;
 * deposits are credited by the chain watcher and moved onto the card; the user hands money and limits to
 * agents, and agents pay through `pay` (REST or MCP). All money movements go through the ledger.
 */
export class CardholderInteractor {
  private readonly issuing = new Map<string, Promise<void>>();
  private readonly paying = new Map<string, Promise<unknown>>();
  /** Spends whose card call is running in this process; reconcile leaves them alone. */
  private readonly inflight = new Set<string>();
  private reconcileRun: Promise<void> | undefined;
  private fundingRun: Promise<void> | undefined;
  private readonly now: () => Date;
  private readonly log: (msg: string) => void;

  constructor(private readonly d: CardholderContext) {
    this.now = d.now ?? (() => new Date());
    this.log = d.log ?? (() => undefined);
  }

  // ---------- developer events ----------

  /** Fire and forget: a webhook problem must never hold up or fail a money movement. */
  private emit(userId: string, type: string, data: Record<string, unknown>): void {
    if (!this.d.onEvent) return;
    void this.d.onEvent(userId, type, data).catch((e) => this.log(`event ${type} for ${userId}: ${errText(e)}`));
  }

  private emitForCard(cardId: string, type: string, data: Record<string, unknown>): void {
    if (!this.d.onEvent) return;
    void this.d.cards.userIdOf(cardId)
      .then((userId) => userId && this.emit(userId, type, { cardId, ...data }))
      .catch((e) => this.log(`event ${type} for card ${cardId}: ${errText(e)}`));
  }

  /** Reports a spend that has just reached a final status. */
  private emitSpend(spendId: string): void {
    if (!this.d.onEvent) return;
    void this.d.spends.findWithOwner(spendId)
      .then((s) => {
        if (!s || s.status === "processing") return;
        this.emit(s.userId, "spend.settled", {
          spendId, cardId: s.cardId, agentId: s.agentId, status: s.status, amountCents: s.amountCents, merchant: s.merchant, mcc: s.mcc, reason: s.reason,
        });
      })
      .catch((e) => this.log(`event spend.settled for ${spendId}: ${errText(e)}`));
  }

  // ---------- boot ----------

  /** Rebuilds in-memory agent state from Postgres and settles anything a crash left half done. */
  async restore(): Promise<void> {
    for (const a of await this.d.agents.all()) this.d.wallets.create(a.cardId, a.agentId, policyOf(a));
    const since = new Date(this.now().getTime() - 2 * 86_400_000);
    // Processing spends count too: their money is held until reconcileSpends() learns what the card did.
    for (const s of await this.d.spends.heldSince(since)) this.d.wallets.restoreSpend(s.cardId, s.agentId, s.spendId, s.amountCents, s.createdAt);
  }

  // ---------- users ----------

  async signup(emailIn: unknown): Promise<{ userId: string; token: string }> {
    const email = requireText(emailIn, "email", 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequestError("email is not valid");
    const userId = newId("u");
    const token = newToken("uk");
    if ((await this.d.users.create({ id: userId, email, tokenHash: hashToken(token) })) === "duplicate") {
      throw conflictError("that email already has an account");
    }
    return { userId, token };
  }

  /**
   * A user made through the developer API. They have no owner token (nobody can sign in to the dashboard as them);
   * the developer reaches them with the developer key, and the end user with a short-lived session.
   * The same externalId returns the same user.
   */
  async createManagedUser(developerId: string, externalIdIn: unknown, emailIn: unknown, privacyIn?: unknown): Promise<{ userId: string; created: boolean }> {
    const externalId = requireText(externalIdIn, "externalId", 120);
    const email = requireText(emailIn, "email", 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequestError("email is not valid");
    if (privacyIn !== undefined && privacyIn !== null && typeof privacyIn !== "boolean") throw badRequestError("privacyMode must be true or false");
    const existing = await this.d.users.findIdByExternalId(developerId, externalId);
    if (existing) return { userId: existing, created: false };
    // Privacy mode is fixed at creation: the developer's default unless this user is created with an explicit choice.
    const privacy = typeof privacyIn === "boolean"
      ? privacyIn
      : await this.d.users.developerPrivacyDefault(developerId);
    const userId = newId("u");
    // A token nobody is given: the owner API needs a uk_ token, and this one is never shown.
    const outcome = await this.d.users.create({ id: userId, email, tokenHash: hashToken(newToken("uk")), developerId, externalId, privacyMode: privacy });
    if (outcome === "duplicate") {
      const again = await this.d.users.findIdByExternalId(developerId, externalId);
      if (again) return { userId: again, created: false };
      throw conflictError("that email already has an account");
    }
    return { userId, created: true };
  }

  /** Whether this user's payments each use a fresh one-time card. */
  async privacyMode(userId: string): Promise<boolean> {
    return (await this.d.users.findById(userId))?.privacyMode === true;
  }

  /** The user's id and the developer who owns them, if any. */
  async userOwner(userId: string): Promise<{ developerId: string | null; externalId: string | null } | undefined> {
    const u = await this.d.users.findById(userId);
    return u ? { developerId: u.developerId, externalId: u.externalId } : undefined;
  }

  /** Mints a session for one of the developer's users. The raw token is returned once. */
  async createSession(developerId: string, userId: string, ttlSeconds: number): Promise<{ token: string; expiresAt: string }> {
    const owner = await this.userOwner(userId);
    if (!owner || owner.developerId !== developerId) throw notFoundError("user not found");
    const token = newToken("us");
    const expiresAt = new Date(this.now().getTime() + ttlSeconds * 1000);
    await this.d.users.createSession({ tokenHash: hashToken(token), userId, developerId, expiresAt });
    // Sessions are cheap; keep the table small.
    await this.d.users.deleteSessionsExpiredBefore(new Date(this.now().getTime() - 86_400_000));
    return { token, expiresAt: expiresAt.toISOString() };
  }

  async userBySession(token: string): Promise<string | undefined> {
    return this.d.users.userIdBySession(hashToken(token), this.now());
  }

  /** Replaces the user's token; the old one stops working at once. */
  async rotateToken(userId: string): Promise<{ token: string }> {
    const token = newToken("uk");
    await this.d.users.setTokenHash(userId, hashToken(token));
    return { token };
  }

  async userByToken(token: string): Promise<string | undefined> {
    return this.d.users.findIdByTokenHash(hashToken(token));
  }

  /** Sends the user's identity straight to Miden. Nothing but the reference and status is kept. */
  async submitKyc(userId: string, input: Partial<IndividualKyc>): Promise<{ kycStatus: string }> {
    const user = await this.user(userId);
    if (user.kycStatus === "Approved") throw conflictError("KYC is already approved");
    if (user.kycStatus === "Initiated" || user.kycStatus === "Pending") throw conflictError("KYC is already in review");
    const kyc = validateKyc(input);
    // A fresh reference per attempt, so a resubmission after rejection is a new Miden request.
    const reference = `kyc-${userId}-${randomBytes(3).toString("hex")}`;
    const res = await this.d.lifecycle.submitKyc(reference, kyc).catch((e) => {
      if (e instanceof CardProviderApiError) throw unprocessableError(`KYC submission rejected: ${providerMessage(e)}`);
      if (isDefiniteRefusal(e)) throw unprocessableError(`KYC submission rejected: ${errText(e)}`);
      throw e;
    });
    const status = res.kycStatus ?? "Initiated";
    await this.d.users.setKycSubmission(userId, reference, status);
    // The submission is recorded; a failed status read is retried by the background poller.
    await this.refresh(userId).catch((e) => this.log(`kyc ${userId}: refresh after submit failed: ${errText(e)}`));
    return { kycStatus: (await this.user(userId)).kycStatus };
  }

  /** Reads KYC status from Miden and, once approved, issues the user's card and deposit address. Safe to repeat. */
  async refresh(userId: string): Promise<void> {
    const running = this.issuing.get(userId);
    if (running) return running;
    const p = this.doRefresh(userId).finally(() => this.issuing.delete(userId));
    this.issuing.set(userId, p);
    return p;
  }

  private async doRefresh(userId: string): Promise<void> {
    const user = await this.user(userId);
    const existing = await this.cardOf(userId);
    if (existing) {
      await this.ensureDepositAddress(existing.cardId);
      return;
    }
    if (!user.kycReference) return;
    const kyc = await this.d.lifecycle.kycStatus(user.kycReference);
    if (kyc.status !== user.kycStatus) {
      await this.d.users.setKycStatus(userId, kyc.status);
      this.emit(userId, "kyc.updated", { kycStatus: kyc.status });
    }
    if (kyc.status !== "Approved" || !kyc.customerId || !kyc.kycToken) return;
    const limits = this.d.tiers[user.tier];
    const policy: SpendPolicy = { perTransactionCents: limits.perTransactionCents, dailyCents: limits.dailyCents };
    // clientReference is stable per user, so the Reference header makes a retried issuance idempotent for 24h.
    const card = await this.d.cardIssuer.issue(`user-${userId}`, policy, { customerId: kyc.customerId, kycToken: kyc.kycToken }, `card-${userId}`);
    await this.d.cards.createIfAbsent({ cardId: card.id, userId, customerId: kyc.customerId, perTxnCents: policy.perTransactionCents, dailyCents: policy.dailyCents });
    this.log(`card issued for ${userId}`);
    this.emit(userId, "card.issued", { cardId: card.id });
    await this.ensureDepositAddress(card.id);
  }

  /** One address per card even when two callers race in this process; they share the running call. */
  private readonly addressing = new Map<string, Promise<string>>();

  private ensureDepositAddress(cardId: string): Promise<string> {
    const running = this.addressing.get(cardId);
    if (running) return running;
    const p = this.doEnsureDepositAddress(cardId).finally(() => this.addressing.delete(cardId));
    this.addressing.set(cardId, p);
    return p;
  }

  private async doEnsureDepositAddress(cardId: string): Promise<string> {
    const have = await this.d.addresses.issuedAddressOf(cardId);
    if (have) return have;
    const idx = await this.d.addresses.nextDerivationIndex();
    const address = (await this.d.deriveAddress(idx)).toLowerCase();
    await this.d.addresses.assign(address, cardId, idx);
    return address;
  }

  /** Everything the owner's dashboard shows. */
  async overview(userId: string) {
    const user = await this.user(userId);
    const card = await this.cardOf(userId);
    const base = { userId, email: user.email, tier: user.tier as Tier, kycStatus: user.kycStatus, privacyMode: user.privacyMode, sandbox: this.d.sandbox, simulatedDeposits: !!(this.d.sandbox && this.d.simulatedDeposits) };
    if (!card) return { ...base, card: null };
    const cardId = card.cardId;
    const [holding, pending, onCard, address, agents, fundings, deposits] = await Promise.all([
      this.d.ledger.balance(accounts.holding(cardId)),
      this.d.ledger.balance(accounts.pending(cardId)),
      this.d.ledger.balance(accounts.card(cardId)),
      this.d.addresses.issuedAddressOf(cardId),
      this.agentsOf(cardId),
      this.d.fundings.recentByCard(cardId, 20),
      this.d.ledger.history(accounts.holding(cardId)),
    ]);
    const midenBalance = await this.d.lifecycle.cardBalance(cardId).catch(() => null);
    const funded = await this.d.fundings.committedCents(cardId);
    const cap = this.d.tiers[user.tier as Tier].lifetimeFundedCents;
    return {
      ...base,
      card: {
        cardId,
        limits: { perTransactionCents: card.perTxnCents, dailyCents: card.dailyCents },
        lifetimeFundingCapCents: this.d.tiers[user.tier as Tier].lifetimeFundedCents,
        balances: {
          awaitingFundingCents: holding,
          awaitingFundingReason: holdingReason(holding, cap - funded, cap),
          fundingInFlightCents: pending,
          unallocatedOnCardCents: onCard,
        },
        lifetimeFundedCents: funded,
        midenCardBalanceDollars: midenBalance,
        deposit: { chain: this.d.chain, asset: "USDC", address: address ?? null, networks: this.d.depositNetworks ?? [this.d.chain, "ethereum-sepolia"], rail: this.d.depositRail ?? "chain" },
        deposits: deposits.filter((t) => t.kind === "deposit").reverse().slice(0, 20).map((t) => ({
          reference: t.reference,
          amountCents: t.postings.find((p) => p.account === accounts.holding(cardId))?.amountCents ?? 0,
          simulated: t.idempotencyKey.startsWith("deposit:sandbox-sim:"),
          chain: t.idempotencyKey.split(":")[1],
          at: t.createdAt,
        })),
        fundings: fundings.map((f) => ({ fundingId: f.fundingId, amountCents: f.amountCents, status: f.status, detail: f.detail, at: f.createdAt })),
        agents,
      },
    };
  }

  /** Sandbox only: credits a deposit as if the chain watcher had seen one. Labelled as simulated in the ledger. */
  async simulateDeposit(userId: string, amountCentsIn: unknown): Promise<void> {
    if (!this.d.sandbox || !this.d.simulatedDeposits) throw forbiddenError("simulated deposits are switched off (sandbox only, ALLOW_SIMULATED_DEPOSITS=1)");
    const amountCents = requireCents(amountCentsIn, "amountCents");
    if (amountCents > 100_000) throw badRequestError("simulated deposits are capped at $1,000");
    const card = await this.requireCard(userId);
    await this.d.ledger.confirmDeposit({ chain: "sandbox-sim", asset: "USDC", cardId: card.cardId, amountCents, txHash: newId("sim", 16), logIndex: 0 });
    void this.fundPending().catch((e) => this.log(`funding: ${errText(e)}`));
  }

  /**
   * Sandbox only: credits a deposit by address, from an id like `sim_<address>_USDC_<amount>` (see parseSimDeposit),
   * through the same ledger.confirmDeposit the chain watcher uses. The address must be this user's own deposit
   * address, so one user cannot credit another's card. The id is the idempotency key.
   */
  async simulateChainDeposit(userId: string, id: unknown): Promise<{ amountCents: number }> {
    if (!this.d.sandbox || !this.d.simulatedDeposits) throw forbiddenError("simulated deposits are switched off (sandbox only, ALLOW_SIMULATED_DEPOSITS=1)");
    const hint = typeof id === "string" ? parseSimDeposit(id) : null;
    if (!hint) throw badRequestError(`id must look like ${SIM_DEPOSIT_PREFIX}<0x address>_<USDC|USDT>_<amount in dollars>[_<nonce>]`);
    if (hint.amountCents > 100_000) throw badRequestError("simulated deposits are capped at $1,000");
    const card = await this.requireCard(userId);
    if ((await this.d.addresses.cardFor(hint.address)) !== card.cardId) throw notFoundError("that is not one of your deposit addresses");
    await this.d.ledger.confirmDeposit({ chain: "sandbox-sim", asset: hint.asset, cardId: card.cardId, amountCents: hint.amountCents, txHash: hint.id, logIndex: 0 });
    void this.fundPending().catch((e) => this.log(`funding: ${errText(e)}`));
    return { amountCents: hint.amountCents };
  }

  // ---------- funding: holding -> Miden card ----------

  /** Top-ups still 'reserved' after `olderThanMs`, oldest first: for alerting. */
  async stuckFundings(olderThanMs: number): Promise<{ fundingId: string; cardId: string; amountCents: number }[]> {
    const cutoff = this.now().getTime() - olderThanMs;
    return (await this.d.fundings.reserved()).filter((f) => f.createdAt.getTime() < cutoff);
  }

  /**
   * Moves credited deposits onto each card with a Miden top-up. A row is written before the ledger
   * reserve and the Miden call share its id, so a crash anywhere is finished by the next run: the
   * Reference header makes the retried top-up land at most once.
   */
  fundPending(): Promise<void> {
    // One run at a time; a caller arriving mid-run waits for that run.
    this.fundingRun ??= this.doFundPending().finally(() => (this.fundingRun = undefined));
    return this.fundingRun;
  }

  private async doFundPending(): Promise<void> {
    {
      for (const f of await this.d.fundings.reserved()) {
        const stale = this.now().getTime() - f.createdAt.getTime() > RESEND_WINDOW_MS;
        // Past the Reference window a re-send could top up twice, so only look for the first one.
        if (stale) await this.findLostFunding(f.fundingId, f.cardId, f.amountCents);
        else await this.settleFunding(f.fundingId, f.cardId, f.amountCents);
      }
      for (const c of await this.d.cards.allWithTier()) {
        const holding = await this.d.ledger.balance(accounts.holding(c.cardId));
        if (holding < MIN_FUNDING_CENTS) continue;
        const room = this.d.tiers[c.tier as Tier].lifetimeFundedCents - (await this.d.fundings.committedCents(c.cardId));
        const amount = Math.min(holding, room);
        if (amount < MIN_FUNDING_CENTS) continue; // over the tier's lifetime cap: stays in holding until the user upgrades
        const fundingId = newId("fund", 8);
        await this.d.fundings.create({ fundingId, cardId: c.cardId, amountCents: amount });
        await this.settleFunding(fundingId, c.cardId, amount);
      }
    }
  }

  private async settleFunding(fundingId: string, cardId: string, amountCents: number): Promise<void> {
    const set = (status: FundingStatus, detail: string | null) => this.d.fundings.setStatus(fundingId, status, detail);
    try {
      await this.d.ledger.reserveFunding({ cardId, amountCents, fundingId });
    } catch (e) {
      // Never reserved (holding moved on): nothing was sent, so the row is simply closed.
      await set("released", `not reserved: ${errText(e)}`);
      return;
    }
    let landed: boolean;
    let detail: string | null = null;
    try {
      if (await this.isPrivacyCard(cardId)) {
        // Privacy mode: the money stays in the Miden wallet and pays for each one-time card as it is issued.
        landed = true;
        detail = "privacy mode: held in the Miden wallet";
      } else {
        const receipt = await this.d.funding.fund({ cardId, amountCents, asset: "USDC", idempotencyKey: fundingId });
        landed = receipt.status === "confirmed";
        detail = `miden ${receipt.id}`;
      }
    } catch (e) {
      if (e instanceof DuplicateReferenceError) {
        // Miden has seen this Reference, which does not prove the top-up succeeded: look for it.
        await this.findLostFunding(fundingId, cardId, amountCents);
        return;
      } else if (e instanceof CardProviderApiError && isDefiniteRefusal(e)) {
        landed = false;
        detail = providerMessage(e);
      } else {
        this.log(`funding ${fundingId} will retry: ${errText(e)}`);
        return; // indeterminate: stays reserved, retried with the same Reference
      }
    }
    if (landed) {
      await this.d.ledger.completeFunding({ cardId, amountCents, fundingId });
      await set("completed", detail);
      this.emitForCard(cardId, "funding.completed", { fundingId, amountCents });
      this.log(`funded card ${cardId.slice(0, 8)} with ${amountCents}c`);
    } else {
      await this.d.ledger.releaseFunding({ cardId, amountCents, fundingId });
      await set("released", detail);
    }
  }

  /**
   * Settles a reserved top-up from the card's own record: CardFunding carries our clientReference
   * (= fundingId) as transactionReference. Not found means unknown, so it stays reserved for a person to check.
   */
  private async findLostFunding(fundingId: string, cardId: string, amountCents: number): Promise<void> {
    let txs: CardTransaction[];
    try {
      txs = await this.d.lifecycle.transactions(cardId, "CardFunding", 100);
    } catch (e) {
      this.log(`funding ${fundingId}: lookup failed, will retry: ${errText(e)}`);
      return;
    }
    const t = txs.find((x) => x.transactionReference === fundingId);
    if (t && /^(approved|successful)$/i.test(t.transactionStatus ?? "")) {
      await this.d.ledger.completeFunding({ cardId, amountCents, fundingId });
      await this.d.fundings.setStatus(fundingId, "completed", `found on the card (${t.id ?? "?"})`);
      this.emitForCard(cardId, "funding.completed", { fundingId, amountCents });
      this.log(`funding ${fundingId}: found on the card, completed`);
    } else if (t && /^(declined|failed)$/i.test(t.transactionStatus ?? "")) {
      await this.d.ledger.releaseFunding({ cardId, amountCents, fundingId });
      await this.d.fundings.setStatus(fundingId, "released", `card shows ${t.transactionStatus}`);
    } else {
      this.log(`funding ${fundingId}: not on the card's recent CardFunding list${t ? ` (status ${t.transactionStatus})` : ""}; left reserved for review`);
    }
  }

  // ---------- agents (owner side) ----------

  async createAgent(userId: string, body: { name?: unknown; perTransactionCents?: unknown; dailyCents?: unknown; allowedMccs?: unknown }) {
    const card = await this.requireCard(userId);
    const name = requireText(body.name, "name", 80);
    const requested: SpendPolicy = {
      perTransactionCents: requireCents(body.perTransactionCents, "perTransactionCents"),
      dailyCents: requireCents(body.dailyCents, "dailyCents"),
    };
    const mccs = parseMccs(body.allowedMccs);
    if (mccs) requested.allowedMccs = mccs;
    checkAgentLimits(requested, card);
    // An agent never gets more room than its owner's card.
    const policy = capPolicy({ perTransactionCents: card.perTxnCents, dailyCents: card.dailyCents, lifetimeFundedCents: 0 }, requested);
    const agentId = newId("a", 4);
    const token = newToken("ak");
    await this.d.agents.create({
      cardId: card.cardId, agentId, name, tokenHash: hashToken(token),
      perTxnCents: policy.perTransactionCents, dailyCents: policy.dailyCents, allowedMccs: policy.allowedMccs ?? null,
    });
    this.d.wallets.create(card.cardId, agentId, policy);
    return { agentId, name, policy, token };
  }

  async fundAgent(userId: string, agentId: string, amountCentsIn: unknown, key?: unknown): Promise<void> {
    const card = await this.requireCard(userId);
    const agent = await this.requireAgent(card.cardId, agentId);
    if (agent.revokedAt) throw conflictError("agent is revoked");
    const amountCents = requireCents(amountCentsIn, "amountCents");
    const allocationId = typeof key === "string" && key ? `${card.cardId}:${agentId}:${key}` : newId("alloc", 8);
    await this.d.wallets.fund(card.cardId, agentId, amountCents, allocationId).catch((e) => {
      if (/insufficient/.test(errText(e))) throw conflictError("not enough unallocated money on the card");
      throw e;
    });
  }

  async reclaimAgent(userId: string, agentId: string, amountCentsIn?: unknown): Promise<number> {
    const card = await this.requireCard(userId);
    await this.requireAgent(card.cardId, agentId);
    // A payment can debit the agent between our balance read and the reclaim: re-read and try once more.
    for (let attempt = 0; ; attempt++) {
      const balance = await this.d.wallets.balance(card.cardId, agentId);
      const amountCents = amountCentsIn === undefined ? balance : requireCents(amountCentsIn, "amountCents");
      if (amountCents === 0) return 0;
      if (amountCents > balance) throw conflictError("agent does not hold that much");
      try {
        await this.d.wallets.reclaim(card.cardId, agentId, amountCents, newId("ret", 8));
        return amountCents;
      } catch (e) {
        if (!(e instanceof LedgerError) && !/insufficient/.test(errText(e))) throw e;
        if (attempt > 0) throw conflictError("the agent's balance changed while reclaiming; try again");
      }
    }
  }

  /** Revokes the agent's token for good and returns its money to the card. */
  async revokeAgent(userId: string, agentId: string): Promise<void> {
    const card = await this.requireCard(userId);
    await this.d.agents.revoke(card.cardId, agentId);
    await this.reclaimAgent(userId, agentId);
  }

  async updateAgentLimits(userId: string, agentId: string, body: { perTransactionCents?: unknown; dailyCents?: unknown; allowedMccs?: unknown }) {
    const card = await this.requireCard(userId);
    const agent = await this.requireAgent(card.cardId, agentId);
    const requested: SpendPolicy = {
      perTransactionCents: body.perTransactionCents === undefined ? agent.perTxnCents : requireCents(body.perTransactionCents, "perTransactionCents"),
      dailyCents: body.dailyCents === undefined ? agent.dailyCents : requireCents(body.dailyCents, "dailyCents"),
    };
    const mccs = body.allowedMccs === undefined ? (agent.allowedMccs ?? undefined) : parseMccs(body.allowedMccs);
    if (mccs) requested.allowedMccs = mccs;
    checkAgentLimits(requested, card);
    const policy = capPolicy({ perTransactionCents: card.perTxnCents, dailyCents: card.dailyCents, lifetimeFundedCents: 0 }, requested);
    await this.d.agents.updateLimits(card.cardId, agentId, {
      perTxnCents: policy.perTransactionCents, dailyCents: policy.dailyCents, allowedMccs: policy.allowedMccs ?? null,
    });
    this.d.wallets.setPolicy(card.cardId, agentId, policy);
    return policy;
  }

  private async agentsOf(cardId: string) {
    const rows = await this.d.agents.listByCard(cardId);
    return Promise.all(rows.map(async (a) => ({
      agentId: a.agentId,
      name: a.name,
      revoked: a.revokedAt !== null,
      policy: policyOf(a),
      balanceCents: await this.d.wallets.balance(cardId, a.agentId),
      spentTodayCents: await this.spentToday(cardId, a.agentId),
      recent: await this.spends(cardId, a.agentId, 10),
    })));
  }

  // ---------- privacy mode: one-time cards ----------

  private async isPrivacyCard(cardId: string): Promise<boolean> {
    return this.d.cards.ownerHasPrivacyMode(cardId);
  }

  /**
   * The card a payment is charged to: the user's own card, or, in privacy mode, a one-time card issued for exactly this
   * payment (after the agent's limits passed and its money was debited). One row per spend, written before the issue
   * call, so the same spend never gets two cards and a crash mid-issue is flagged, not guessed at.
   * Throws an AgentCardsError when no card could be made; the caller then undoes the debit (nothing was charged).
   * `needDetails`: also seal the card's details into the vault (a hosted-checkout fill needs them; the simulator does not).
   * `forceOneTime`: a one-time card even outside privacy mode (a checkout on a host that is not on the swap allowlist).
   */
  async chargeCardFor(p: AgentPrincipal, spendId: string, amountCents: number, opts: { needDetails: boolean; forceOneTime?: boolean }): Promise<string> {
    if (!opts.forceOneTime && !(await this.privacyMode(p.userId))) return p.cardId;
    const prior = await this.d.oneTimeCards.findBySpend(spendId);
    if (prior?.status === "ready" && prior.cardId) return prior.cardId;
    // Miden loads at least $1 on a Lite card, so a smaller payment would park the rest of a dollar on a single-swipe card.
    if (!prior && amountCents < ONE_TIME_MIN_CENTS) throw unprocessableError("privacy mode needs a payment of at least $1.00 (the smallest one-time card); nothing was charged");
    // A card that is refused or abandoned keeps its funds until it terminates, so cap how fast one user can make cards.
    if (!prior) {
      const n = await this.d.oneTimeCards.countStartedInLastDay(p.userId);
      if (n >= ONE_TIME_MAX_PER_DAY) throw tooManyRequestsError(`privacy mode allows ${ONE_TIME_MAX_PER_DAY} one-time cards a day per user; nothing was charged`);
    }
    if (prior) throw conflictError("a one-time card for this payment was already attempted and needs a person to look at it; nothing was charged");
    const rowId = newId("ot", 8);
    const mark = (status: OneTimeCardStatus, detail: string | null, cardId?: string) => this.d.oneTimeCards.mark(rowId, status, detail, cardId);
    if ((await this.d.oneTimeCards.start({ oneTimeId: rowId, userId: p.userId, spendId, amountCents })) === "duplicate") {
      // A concurrent attempt for the same spend won the unique index.
      throw conflictError("a one-time card for this payment is already being made; nothing was charged");
    }
    const user = await this.user(p.userId);
    let kyc: { status: string; customerId?: string; kycToken?: string };
    try {
      kyc = await this.d.lifecycle.kycStatus(user.kycReference!);
    } catch (e) {
      await mark("failed", `KYC lookup failed: ${errText(e)}`.slice(0, 200));
      throw unavailableError("could not look up the cardholder to make a one-time card; nothing was charged");
    }
    if (kyc.status !== "Approved" || !kyc.customerId || !kyc.kycToken) {
      await mark("failed", `KYC status ${kyc.status}`);
      throw conflictError("the cardholder is not approved, so no one-time card can be made; nothing was charged");
    }
    let out: { cardId: string; detailsCaptured: boolean };
    try {
      out = await this.d.cardIssuer.issueOneTime({ customerId: kyc.customerId, kycToken: kyc.kycToken }, amountCents, `ot-${spendId}`, { capture: opts.needDetails });
    } catch (e) {
      if (isDefiniteRefusal(e)) {
        const why = e instanceof CardProviderApiError ? providerMessage(e) : errText(e);
        await mark("failed", why.slice(0, 200));
        throw unprocessableError(`could not make a one-time card (${why}); nothing was charged`);
      }
      // A timeout or lost answer: the card may exist (and hold the money). Never guess; a person decides.
      await mark("needs_review", `issue answer lost: ${errText(e)}`.slice(0, 200));
      this.log(`one-time card for spend ${spendId}: issue answer lost, flagged for review`);
      throw unavailableError("the one-time card could not be confirmed; nothing was charged and the attempt is flagged for review");
    }
    if (opts.needDetails && !out.detailsCaptured) {
      await mark("needs_review", "card issued but its details could not be captured", out.cardId);
      throw badGatewayError("the one-time card was made but its details were unavailable; nothing was charged and the card is flagged for review");
    }
    await mark("ready", null, out.cardId);
    await this.d.spends.setChargeCard(spendId, out.cardId);
    this.log(`one-time card ${out.cardId.slice(0, 8)} made for spend ${spendId}`);
    return out.cardId;
  }

  // ---------- agents (agent side) ----------

  async agentByToken(token: string): Promise<AgentPrincipal | undefined> {
    return this.d.agents.findActiveByTokenHash(hashToken(token));
  }

  async agentWallet(p: AgentPrincipal) {
    const policy = this.d.wallets.policy(p.cardId, p.agentId);
    if (!policy) throw notFoundError("agent not found");
    const spentTodayCents = await this.spentToday(p.cardId, p.agentId);
    return {
      agentId: p.agentId,
      name: p.name,
      currency: "USD",
      balanceCents: await this.d.wallets.balance(p.cardId, p.agentId),
      limits: { perTransactionCents: policy.perTransactionCents, dailyCents: policy.dailyCents, allowedMccs: policy.allowedMccs ?? null },
      spentTodayCents,
      remainingTodayCents: Math.max(0, policy.dailyCents - spentTodayCents),
    };
  }

  async agentTransactions(p: AgentPrincipal, limit = 20): Promise<SpendView[]> {
    return this.spends(p.cardId, p.agentId, Math.min(Math.max(1, limit), 100));
  }

  /**
   * An agent pays a merchant with its owner's card. Our policy and the agent's sub-balance are checked
   * and debited first; then the card is charged (sandbox: Miden's simulated authorization). If the card
   * definitely refuses, our debit is reversed. If its answer is lost (timeout, 5xx), the payment stays
   * "processing" with the money held, and reconcileSpends() settles it from the card's transactions.
   * The same idempotency key never charges twice.
   */
  async pay(p: AgentPrincipal, req: PayRequest, opts: { internal?: boolean; charge?: Charger } = {}): Promise<SpendView> {
    const amountCents = requireCents(req.amountCents, "amount");
    const merchant = requireText(req.merchant, "merchant", 80);
    const mcc = req.mcc === undefined || req.mcc === null || req.mcc === "" ? undefined : String(req.mcc);
    if (mcc !== undefined && !/^\d{4}$/.test(mcc)) throw badRequestError("mcc must be 4 digits");
    const key = req.idempotencyKey === undefined || req.idempotencyKey === "" ? newId("auto", 12) : requireText(req.idempotencyKey, "idempotencyKey", 100);
    // Checkout keys are ours (CheckoutInteractor): an agent pre-spending under one could pass it off as the checkout's payment.
    if (key.startsWith(INTERNAL_KEY_PREFIX) && !opts.internal) throw badRequestError(`idempotencyKey must not start with "${INTERNAL_KEY_PREFIX}"`);
    // A swap charge must live under a swap key, so the right reconcile owns it; and a swap key always has one.
    if (Boolean(opts.charge) !== key.startsWith(SWAP_KEY_PREFIX)) throw badRequestError("a custom charge needs a swap key, and a swap key needs a custom charge");
    const lockKey = `${p.cardId}:${p.agentId}:${key}`;
    // One attempt per key at a time in this process; the unique index covers the rest.
    while (this.paying.has(lockKey)) await this.paying.get(lockKey)!.catch(() => undefined);
    const run = this.doPay(p, { amountCents, merchant, mcc, key }, opts.charge);
    this.paying.set(lockKey, run);
    try {
      return await run;
    } finally {
      this.paying.delete(lockKey);
    }
  }

  /** The earlier result for this key, or a 409 if the key was used for a different payment. */
  private async priorSpend(p: AgentPrincipal, r: { amountCents: number; merchant: string; mcc?: string; key: string }): Promise<SpendView | undefined> {
    const s = await this.d.spends.findByKey(p.cardId, p.agentId, r.key);
    if (!s) return undefined;
    if (s.amountCents !== r.amountCents || s.merchant !== r.merchant || (s.mcc ?? undefined) !== r.mcc) {
      throw conflictError("that idempotency key was already used for a different payment");
    }
    return spendView(s);
  }

  /**
   * Records the spend, checking the agent's and the card's daily limits under a row lock on the card, so
   * concurrent payments (in any process) cannot both fit. Over a limit, the row is written as declined.
   */
  private openSpend(p: AgentPrincipal, r: { amountCents: number; merchant: string; mcc?: string; key: string }, spendId: string, policy: SpendPolicy): Promise<OpenSpendResult> {
    const draft = { spendId, cardId: p.cardId, agentId: p.agentId, idempotencyKey: r.key, amountCents: r.amountCents, merchant: r.merchant, mcc: r.mcc ?? null };
    return this.d.spends.open(draft, this.today(), (t) => {
      // The agent's own policy first (per payment, merchant category, daily), so its reasons read as before.
      const verdict = evaluate(policy, { amountCents: r.amountCents, mcc: r.mcc, spentTodayCents: t.agentSpentCents });
      return !verdict.ok ? verdict.reason
        : t.cardSpentCents + r.amountCents > t.cardDailyCents ? "card daily limit exceeded (shared by all agents on this card)"
        : null;
    });
  }

  private async doPay(p: AgentPrincipal, r: { amountCents: number; merchant: string; mcc?: string; key: string }, charge?: Charger): Promise<SpendView> {
    const prior = await this.priorSpend(p, r);
    if (prior) return prior;
    const policy = this.d.wallets.policy(p.cardId, p.agentId);
    if (!policy) throw notFoundError("agent not found");
    const spendId = newId("sp", 10);
    // In flight from before the row exists, so this process's reconcile never judges a payment still under way.
    this.inflight.add(spendId);
    try {
      return await this.chargeSpend(p, r, policy, spendId, charge);
    } finally {
      this.inflight.delete(spendId);
    }
  }

  private async chargeSpend(p: AgentPrincipal, r: { amountCents: number; merchant: string; mcc?: string; key: string }, policy: SpendPolicy, spendId: string, charge?: Charger): Promise<SpendView> {
    const result = await this.openSpend(p, r, spendId, policy);
    if (result.outcome === "card_not_found") throw notFoundError("card not found");
    if (result.outcome === "duplicate_key") {
      // Another process inserted the same key first: answer with its result.
      const again = await this.priorSpend(p, r);
      if (again) return again;
      throw conflictError("a payment with that idempotency key is already in progress");
    }
    const opened = spendView(result.spend);
    if (opened.status !== "processing") return opened;
    const finish = async (status: SpendView["status"], reason: string | null, extra: { seq?: number; auth?: string } = {}) => {
      const row = await this.d.spends.finish(spendId, status, reason, extra);
      this.emitSpend(spendId);
      return spendView(row!);
    };
    // Daily limits were checked in openSpend (Postgres, shared by every process); this checks the rest and debits.
    const verdict = await this.d.wallets.spend(p.cardId, p.agentId, r.amountCents, spendId, r.mcc, { dailyCheckedByCaller: true });
    if (!verdict.ok) return finish("declined", verdict.reason);
    if (!(await this.d.spends.setLedgerSeqIfProcessing(spendId, verdict.tx.seq))) {
      // Another process's reconcile closed it while the debit was slow: undo the debit and never charge the card.
      await this.d.wallets.voidSpend(spendId, verdict.tx);
      return spendView((await this.d.spends.find(spendId))!);
    }
    if (charge) {
      let out: ChargeOutcome;
      try {
        out = await charge(spendId);
      } catch (e) {
        out = { kind: "unknown", reason: `charge failed: ${errText(e)}` };
      }
      if (out.kind === "approved") return finish("approved", null, { seq: verdict.tx.seq, auth: out.auth });
      if (out.kind === "refused") {
        await this.d.wallets.voidSpend(spendId, verdict.tx);
        return finish("voided", out.reason);
      }
      this.log(`spend ${spendId}: swap charge outcome unknown, held for reconcile`);
      return finish("processing", out.reason, { seq: verdict.tx.seq });
    }
    if (!this.d.sandbox) {
      await this.d.wallets.voidSpend(spendId, verdict.tx);
      return finish("voided", "live card charging is not enabled: agents pay through the sandbox simulator only");
    }
    let cardId: string;
    try {
      cardId = await this.chargeCardFor(p, spendId, r.amountCents, { needDetails: false });
    } catch (e) {
      if (!(e instanceof AgentCardsError)) throw e;
      await this.d.wallets.voidSpend(spendId, verdict.tx);
      return finish("voided", e.message);
    }
    try {
      const authId = await this.d.lifecycle.simulateAuthorization(
        { cardId, amountDollars: r.amountCents / 100, mcc: r.mcc, merchantName: r.merchant, mid: midFor(spendId) },
        { idempotencyKey: `auth:${spendId}` },
      );
      return finish("approved", null, { seq: verdict.tx.seq, auth: authId ?? undefined });
    } catch (e) {
      if (isDefiniteRefusal(e)) {
        await this.d.wallets.voidSpend(spendId, verdict.tx);
        return finish("voided", `card declined: ${e instanceof CardProviderApiError ? providerMessage(e) : errText(e)}`);
      }
      // We cannot tell whether the card was charged. Keep the money held; never re-send (the mock is not idempotent).
      this.log(`spend ${spendId}: card answer lost, reconciling later: ${errText(e)}`);
      return finish("processing", "waiting for the card network's answer; the money is held. Check again with list_transactions, and do not retry with a new key", { seq: verdict.tx.seq });
    }
  }

  /**
   * Settles payments left "processing" (lost card answer, crash, restart) from the card's own
   * Authorization list, matched exactly by the per-spend merchant id. Run it in the background.
   */
  reconcileSpends(): Promise<void> {
    this.reconcileRun ??= this.doReconcileSpends().finally(() => (this.reconcileRun = undefined));
    return this.reconcileRun;
  }

  private async doReconcileSpends(): Promise<void> {
    const before = new Date(this.now().getTime() - RECONCILE_AFTER_MS);
    // Swap spends are settled by SwapInteractor.reconcile (matched on the card by amount and time, not by mid).
    const rows = await this.d.spends.processingBefore(before, SWAP_KEY_PREFIX, 200);
    const lists = new Map<string, Promise<CardTransaction[]>>();
    for (const s of rows) {
      if (this.inflight.has(s.spendId)) continue;
      await this.reconcileSpend(s, lists).catch((e) => this.log(`reconcile ${s.spendId}: ${errText(e)}`));
    }
  }

  private async reconcileSpend(s: Spend, lists: Map<string, Promise<CardTransaction[]>>): Promise<void> {
    const spendId = s.spendId;
    const settle = async (status: SpendView["status"], reason: string | null, auth?: string) => {
      const moved = await this.d.spends.settleProcessing(spendId, status, reason, auth);
      if (moved) this.emitSpend(spendId);
      return moved;
    };
    // Found by key, not ledger_seq: the debit can commit before its seq is saved on the row.
    const tx: LedgerTransaction | undefined = await this.d.ledger.findByKey(`spend:${spendId}`);
    if (!tx) {
      // The card is charged only after the agent is debited, so nothing was charged. Guarded on ledger_seq: if a
      // slow payment in another process debits meanwhile, it sees the row closed and undoes its own debit.
      await this.d.spends.voidUndebited(spendId, "interrupted before payment; nothing was charged");
      return;
    }
    if (s.ledgerSeq === null) await this.d.spends.setLedgerSeqIfProcessing(spendId, tx.seq);
    let found: CardTransaction | undefined;
    if (this.d.sandbox) {
      const onCard = s.chargeCardId ?? s.cardId;
      if (!lists.has(onCard)) lists.set(onCard, this.d.lifecycle.transactions(onCard, "Authorization", 100));
      const mid = midFor(spendId);
      found = (await lists.get(onCard)!).find((t) => t.merchantMid === mid);
    }
    const status = found?.transactionStatus ?? "";
    if (/^(approved|successful|settled)$/i.test(status)) {
      await settle("approved", null, found!.authCode);
      this.log(`reconcile ${spendId}: approved on the card`);
    } else if (/^(declined|failed|reversed)$/i.test(status)) {
      await this.d.wallets.voidSpend(spendId, tx);
      await settle("voided", `card declined (${status})`);
    } else {
      // Not found, or a status we do not know. Absence on one page of a lagging list does not prove it was
      // not charged, so never refund here: keep the money held and flag it for a person (like findLostFunding).
      const note = found
        ? `needs review: the card shows status "${status}"; the money is held`
        : this.now().getTime() - s.createdAt.getTime() > GIVE_UP_AFTER_MS
          ? "needs review: the card network has no record of this payment yet; the money is held"
          : null;
      if (note && s.reason !== note) {
        await this.d.spends.noteProcessing(spendId, note);
        this.log(`reconcile ${spendId}: ${note}`);
      }
    }
  }

  /**
   * Settles a processing swap spend from outside (SwapInteractor.reconcile): approved keeps the debit, voided
   * undoes it. Only ever moves a row out of processing, once; returns false if it was not processing.
   */
  async resolveSwapSpend(spendId: string, out: { status: "approved"; auth?: string } | { status: "voided"; reason: string }): Promise<boolean> {
    const s = await this.d.spends.find(spendId);
    if (!s || !s.idempotencyKey.startsWith(SWAP_KEY_PREFIX)) return false;
    // A voided row is re-voided (the reversal is idempotent), which repairs a crash between closing the row and undoing the debit.
    if (s.status !== "processing" && !(s.status === "voided" && out.status === "voided")) return false;
    if (out.status === "approved") {
      const moved = await this.d.spends.settleProcessing(spendId, "approved", null, out.auth);
      if (moved) this.emitSpend(spendId);
      return moved;
    }
    // Close the row first, then undo the debit: two reconcilers racing cannot both refund.
    if (s.status === "processing") {
      if (!(await this.d.spends.settleProcessing(spendId, "voided", out.reason))) return false;
      this.emitSpend(spendId);
    }
    const tx = await this.d.ledger.findByKey(`spend:${spendId}`);
    if (tx) await this.d.wallets.voidSpend(spendId, tx);
    return true;
  }

  /** Puts a note on a processing spend (e.g. "needs review"), visible to the agent in list_transactions. */
  async noteSpend(spendId: string, reason: string): Promise<void> {
    await this.d.spends.noteProcessing(spendId, reason);
  }

  // ---------- helpers ----------

  /** Today's UTC day, as [start, end). The same day boundary AgentWallets uses. */
  private today(): [Date, Date] {
    const start = new Date(`${this.now().toISOString().slice(0, 10)}T00:00:00Z`);
    return [start, new Date(start.getTime() + 86_400_000)];
  }

  /** Approved and still-processing spends today: a processing payment's money is held until it settles. */
  private spentToday(cardId: string, agentId: string): Promise<number> {
    const [start, end] = this.today();
    return this.d.spends.agentSpentBetween(cardId, agentId, start, end);
  }

  private async spends(cardId: string, agentId: string, limit: number): Promise<SpendView[]> {
    return (await this.d.spends.recentByAgent(cardId, agentId, limit)).map(spendView);
  }

  private async user(userId: string) {
    const u = await this.d.users.findById(userId);
    if (!u) throw notFoundError("user not found");
    return u;
  }

  private cardOf(userId: string): Promise<Card | undefined> {
    return this.d.cards.findByUser(userId);
  }

  private async requireCard(userId: string): Promise<Card> {
    const card = await this.cardOf(userId);
    if (!card) throw conflictError("no card yet: complete KYC first");
    return card;
  }

  private async requireAgent(cardId: string, agentId: string): Promise<Agent> {
    const a = await this.d.agents.find(cardId, agentId);
    if (!a) throw notFoundError("agent not found");
    return a;
  }

  /** Users with KYC still in review, for the background poller. */
  async pendingKycUsers(): Promise<string[]> {
    return this.d.users.pendingKycUserIds();
  }
}

/** Owner-chosen agent limits must fit the card's and make sense together; say so instead of silently capping. */
function checkAgentLimits(p: SpendPolicy, card: Pick<Card, "perTxnCents" | "dailyCents">): void {
  if (p.perTransactionCents > card.perTxnCents) throw badRequestError(`per-payment limit can be at most ${usd(card.perTxnCents)}, the card's limit`);
  if (p.dailyCents > card.dailyCents) throw badRequestError(`daily limit can be at most ${usd(card.dailyCents)}, the card's limit`);
  if (p.perTransactionCents > p.dailyCents) throw badRequestError("per-payment limit cannot be more than the daily limit");
}

/** Why money is sitting in holding instead of moving to the card, or null if it will move on the next run. */
function holdingReason(holdingCents: number, roomCents: number, capCents: number): string | null {
  if (holdingCents <= 0) return null;
  if (roomCents < MIN_FUNDING_CENTS) return `this card reached its lifetime funding limit of ${usd(capCents)}; verify your identity for a higher tier to move it`;
  if (holdingCents < MIN_FUNDING_CENTS) return `below the ${usd(MIN_FUNDING_CENTS)} minimum top-up; it moves once more arrives`;
  if (holdingCents > roomCents) return `${usd(roomCents)} more can move before this card's lifetime funding limit of ${usd(capCents)}; the rest stays here`;
  return null;
}

function policyOf(a: Pick<Agent, "perTxnCents" | "dailyCents" | "allowedMccs">): SpendPolicy {
  const p: SpendPolicy = { perTransactionCents: a.perTxnCents, dailyCents: a.dailyCents };
  if (a.allowedMccs && a.allowedMccs.length) p.allowedMccs = a.allowedMccs;
  return p;
}

function spendView(s: Spend): SpendView {
  return {
    spendId: s.spendId,
    amountCents: s.amountCents,
    merchant: s.merchant,
    mcc: s.mcc ?? null,
    status: s.status,
    reason: s.reason ?? null,
    createdAt: s.createdAt.toISOString(),
  };
}

function parseMccs(v: unknown): string[] | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const list = Array.isArray(v) ? v : String(v).split(",");
  const mccs = list.map((x) => String(x).trim()).filter(Boolean);
  if (!mccs.every((m) => /^\d{4}$/.test(m))) throw badRequestError("allowedMccs must be 4-digit codes");
  return mccs.length ? mccs : undefined;
}

function validateKyc(k: Partial<IndividualKyc>): IndividualKyc {
  const t = (v: unknown, what: string) => requireText(v, what, 120);
  const dob = t(k.dateOfBirth, "dateOfBirth");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) throw badRequestError("dateOfBirth must be YYYY-MM-DD");
  const idType = t(k.idType, "idType").toUpperCase();
  if (!ID_TYPES.has(idType)) throw badRequestError(`idType must be one of ${[...ID_TYPES].join(", ")}`);
  const image = requireText(k.idFrontImage, "idFrontImage", 1_500_000);
  if (!/^data:image\/(png|jpe?g);base64,/.test(image)) throw badRequestError("idFrontImage must be a PNG or JPEG data URI");
  const a = k.address ?? ({} as IndividualKyc["address"]);
  return {
    firstName: t(k.firstName, "firstName"), lastName: t(k.lastName, "lastName"), dateOfBirth: dob, idType,
    idNumber: t(k.idNumber, "idNumber"), idFrontImage: image, phone: t(k.phone, "phone"), email: t(k.email, "email"),
    address: { address1: t(a.address1, "address1"), city: t(a.city, "city"), state: t(a.state, "state"), zipcode: t(a.zipcode, "zipcode"), country: t(a.country, "country") },
  };
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
