import type { CardLifecyclePort, IndividualKyc } from "../../domain/interfaces/CardIssuing.js";
import type { Tier, TieredCard, TieredCardIssuer } from "../../lib/services/tiers.js";

export type { IndividualKyc };

export type OnboardingState =
  | { state: "pending"; status: string }
  | { state: "rejected" }
  | { state: "active"; card: TieredCard };

/**
 * Signup: the user does a quick Card KYC, and once the card provider approves it they get one real card under their own
 * customer. Agents then use that card through wallet sub-balances, so they need no KYC of their own.
 * Identity data is passed straight to the provider and never logged or kept here.
 */
export class Onboarding {
  private readonly cards = new Map<string, Promise<TieredCard>>();

  constructor(
    private readonly lifecycle: CardLifecyclePort,
    private readonly issuer: TieredCardIssuer,
  ) {}

  /** clientReference is stable per user, so a retry cannot create a second customer. */
  static kycReference(userId: string): string {
    return `kyc-${userId}`;
  }

  async submitKyc(userId: string, kyc: IndividualKyc): Promise<void> {
    await this.lifecycle.submitKyc(Onboarding.kycReference(userId), kyc);
  }

  /** Checks the user's KYC and, once approved, issues their single card (concurrent calls share one issuance). */
  async status(userId: string, tier: Tier = "quick"): Promise<OnboardingState> {
    const existing = this.cards.get(userId);
    if (existing) return { state: "active", card: await existing };
    const kyc = await this.lifecycle.kycStatus(Onboarding.kycReference(userId));
    if (kyc.status === "Rejected") return { state: "rejected" };
    if (kyc.status !== "Approved" || !kyc.customerId || !kyc.kycToken) return { state: "pending", status: kyc.status };
    let issuing = this.cards.get(userId);
    if (!issuing) {
      issuing = this.issuer.issue(userId, { customerId: kyc.customerId, kycToken: kyc.kycToken }, tier, `card-${userId}`);
      this.cards.set(userId, issuing);
      // A failed issuance must not block a later retry (same clientReference keeps the provider idempotent).
      issuing.catch(() => this.cards.delete(userId));
    }
    return { state: "active", card: await issuing };
  }
}
