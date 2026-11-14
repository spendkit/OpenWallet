import type { FundingReceipt, Stablecoin } from "../../domain/interfaces/FundingSource.js";
import type { SpendPolicy } from "./spendPolicy.js";
import type { AgentCard, CardholderKyc, CardIssuerPort } from "../../domain/interfaces/CardIssuing.js";

export type Tier = "quick" | "full";

export interface TierLimits {
  perTransactionCents: number;
  dailyCents: number;
  /** Total a user may ever load onto cards at this tier. */
  lifetimeFundedCents: number;
}

/** PLACEHOLDER amounts: thresholds are not set. Inject real values. */
export const DEFAULT_TIERS: Record<Tier, TierLimits> = {
  quick: { perTransactionCents: 5_000, dailyCents: 10_000, lifetimeFundedCents: 50_000 },
  full: { perTransactionCents: 100_000, dailyCents: 500_000, lifetimeFundedCents: Number.MAX_SAFE_INTEGER },
};

export type TierDecision = { ok: true } | { ok: false; reason: string; upgradeRequired: boolean };

/** Clamps a requested policy to the tier's caps; never raises it. */
export function capPolicy(limits: TierLimits, requested: SpendPolicy): SpendPolicy {
  return {
    ...requested,
    perTransactionCents: Math.min(requested.perTransactionCents, limits.perTransactionCents),
    dailyCents: Math.min(requested.dailyCents, limits.dailyCents),
  };
}

export interface TieredCard extends AgentCard {
  userId: string;
  tier: Tier;
}

/**
 * Every user completes their own Card KYC at signup and gets one real card under their own customer at the card provider.
 * The tier is how deep that KYC was: "quick" (fast check, low limits) or "full" (more verification, higher limits).
 * Funding past a quick user's lifetime cap is refused until they reach "full".
 */
export class TieredCardIssuer {
  /** Funded per user, in memory only (lost on restart); persist before production. */
  private readonly funded = new Map<string, number>();

  constructor(
    private readonly cards: Pick<CardIssuerPort, "issue" | "topUp" | "authorize">,
    private readonly tiers: Record<Tier, TierLimits> = DEFAULT_TIERS,
  ) {}

  /** One card per user. The card's limits are the tier's caps (pushed to the provider as card limits). */
  async issue(userId: string, kyc: CardholderKyc, tier: Tier, clientReference: string): Promise<TieredCard> {
    const limits = this.tiers[tier];
    const policy = capPolicy(limits, { perTransactionCents: limits.perTransactionCents, dailyCents: limits.dailyCents });
    const card = await this.cards.issue(`user-${userId}`, policy, kyc, clientReference);
    return { ...card, userId, tier };
  }

  limits(tier: Tier): TierLimits {
    return this.tiers[tier];
  }

  /** Checks a load against the user's remaining lifetime allowance. Does not record it. */
  checkFunding(userId: string, tier: Tier, amountCents: number): TierDecision {
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
      return { ok: false, reason: "amount must be a positive whole number of cents", upgradeRequired: false };
    }
    const cap = this.tiers[tier].lifetimeFundedCents;
    if ((this.funded.get(userId) ?? 0) + amountCents > cap) {
      return {
        ok: false,
        reason: tier === "quick" ? "funding limit reached; verify identity to raise it" : "funding limit reached",
        upgradeRequired: tier === "quick",
      };
    }
    return { ok: true };
  }

  async topUp(card: TieredCard, amountCents: number, asset: Stablecoin, idempotencyKey: string): Promise<FundingReceipt> {
    const decision = this.checkFunding(card.userId, card.tier, amountCents);
    if (!decision.ok) throw new Error(decision.reason);
    // Reserve before awaiting so concurrent loads cannot both pass the cap; release if the load fails.
    this.funded.set(card.userId, (this.funded.get(card.userId) ?? 0) + amountCents);
    try {
      return await this.cards.topUp(card, amountCents, asset, idempotencyKey);
    } catch (err) {
      this.funded.set(card.userId, (this.funded.get(card.userId) ?? 0) - amountCents);
      throw err;
    }
  }
}
