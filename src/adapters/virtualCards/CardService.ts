import type { FundingReceipt, FundingSource, Stablecoin } from "../../domain/interfaces/FundingSource.js";
import type { MidenClient } from "../../lib/clients/cardIssuing/miden/MidenClient.js";
import { referenceFor } from "../funding/MidenWalletFunding.js";
import { MidenBusinessError } from "./CardLifecycle.js";
import type { AgentCard, AuthorizationResult, CardIssuerPort, CardholderKyc } from "../../domain/interfaces/CardIssuing.js";

export type { AgentCard, AuthorizationResult, CardholderKyc };
import { decryptSecureCardDetails, fetchFullCardDetails, type DetailKeys } from "../../lib/clients/cardIssuing/miden/cardDetails.js";
import type { CardDetails, CardVault, CaptureSource } from "../cardVault/CardVault.js";
import type { SpendPolicy } from "../../lib/services/spendPolicy.js";
import { SpendTracker } from "../../lib/services/SpendTracker.js";

/** A one-time card is set to terminate itself this many days after issue (Miden does not terminate cards on the day they are made). */
export const ONE_TIME_TERMINATE_DAYS = 2;

/** Card-detail capture at issue: decrypt Miden's secureCardDetails and seal it into the vault. */
export interface CaptureConfig {
  vault: Pick<CardVault, "put" | "has">;
  keys: DetailKeys;
  /** Never receives card data: only ids, last4 and scheme names. */
  log?: (msg: string) => void;
}

interface IssueResponse {
  isSuccessful?: boolean;
  responseCode?: string;
  responseMessage?: string;
  data?: { cardId?: string; firstSix?: string; lastFour?: string; secureCardDetails?: string };
}

/**
 * Issues cards for agents and tops them up from stablecoins.
 * Issuance is POST api/v2/cards/issue (docs/miden-api.md); shapes are from the docs, UNCONFIRMED against the sandbox.
 */
export class CardService implements CardIssuerPort {
  private readonly tracker: SpendTracker;

  constructor(
    private readonly miden: MidenClient,
    private readonly funding: FundingSource,
    private readonly now: () => Date = () => new Date(),
    private readonly capture?: CaptureConfig,
  ) {
    this.tracker = new SpendTracker(now);
  }

  /**
   * `clientReference` must be stable per card (not per agent): it is sent as both the
   * body `clientReference` and, hashed, the Reference header, so retrying an issuance
   * after a timeout with the same value cannot create a second card.
   * With a CaptureConfig, `secureCardDetails` (encrypted PAN/CVV) is decrypted and sealed into the vault
   * before this returns; it is never returned, logged or kept. Capture failing does not fail the issue (the
   * card exists and the wallet was debited): the card comes back with detailsCaptured: false, and
   * captureDetails() retries through the full-PAN endpoint.
   */
  async issue(agentId: string, policy: SpendPolicy, kyc: CardholderKyc, clientReference: string, initialBalanceDollars = 1): Promise<AgentCard> {
    const res = await this.miden.request<IssueResponse>(
      "POST",
      "/api/v2/cards/issue",
      {
        customerId: kyc.customerId,
        kycToken: kyc.kycToken,
        cardBrand: "Visa",
        // Sandbox rejects less than 1 (responseCode 117, "Card Balance Less that Initial Minimum Card of 1").
        initialBalance: initialBalanceDollars,
        clientReference,
        walletCurrency: "USD",
        cardCurrency: "USD",
        // Major units (dollars), as strings per the docs example. UNCONFIRMED.
        cardLimits: {
          dailyLimit: (policy.dailyCents / 100).toFixed(2),
          transactionLimit: (policy.perTransactionCents / 100).toFixed(2),
        },
        ...(policy.allowedMccs ? { whiteListedMccs: policy.allowedMccs } : {}),
      },
      // Sandbox issuance sometimes takes over 15s; a timeout is safe (same Reference on retry) but noisy.
      { reference: referenceFor(`issue:${clientReference}`), timeoutMs: 60_000 },
    );
    // HTTP 2xx does not imply business success.
    const cardId = res.data?.cardId;
    if (res.isSuccessful !== true || res.responseCode !== "000" || !cardId) {
      throw new Error(`Miden card issuance failed: ${res.responseCode ?? "?"} ${res.responseMessage ?? ""}`);
    }
    if (!this.capture) return { id: cardId, agentId, policy };
    const detailsCaptured = await this.captureFromIssue(cardId, res.data!).catch((e: unknown) => {
      this.capture!.log?.(`card ${cardId}: capture at issue failed: ${(e as Error).message}`);
      return false;
    }) || (await this.captureDetails(cardId));
    return { id: cardId, agentId, policy, detailsCaptured };
  }

  /**
   * A one-time card: Miden "Lite" card with one swipe and exactly `amountCents` on it (debited from the funding wallet at
   * issue; Lite cards cannot be topped up). Ends on its first successful use, or at `terminateDate`, whichever is first.
   * `clientReference` must be stable per payment so a retried issue cannot create a second card.
   * With `capture` and a vault, the details are sealed into the vault like any card's; skip it when only the card id is needed.
   */
  async issueOneTime(
    kyc: CardholderKyc, amountCents: number, clientReference: string,
    opts: { capture: boolean; terminateInDays?: number },
  ): Promise<{ cardId: string; lastFour?: string; detailsCaptured: boolean }> {
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new Error("amount must be a positive whole number of cents");
    const now = this.now();
    const expires = new Date(now);
    expires.setUTCMonth(expires.getUTCMonth() + 37); // Miden: at least 36 months from issue
    const terminates = new Date(now.getTime() + (opts.terminateInDays ?? ONE_TIME_TERMINATE_DAYS) * 86_400_000);
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const res = await this.miden.request<IssueResponse>(
      "POST",
      "/api/v2/cards/issue-lite",
      {
        customerId: kyc.customerId, kycToken: kyc.kycToken, swipeCount: 1,
        // Sandbox minimum card balance is $1 (responseCode 117); a smaller payment leaves the rest on the card.
        cardBalance: Math.max(amountCents, 100) / 100,
        expirationDate: day(expires), terminateDate: day(terminates),
        cardBrand: "Visa", walletCurrency: "USD", cardCurrency: "USD", clientReference, contactlessPayment: false,
      },
      { reference: referenceFor(`issue-lite:${clientReference}`), timeoutMs: 60_000 },
    );
    const cardId = res.data?.cardId;
    if (res.isSuccessful !== true || res.responseCode !== "000" || !cardId) {
      throw new MidenBusinessError(`Miden one-time card issuance failed: ${res.responseCode ?? "?"} ${res.responseMessage ?? ""}`);
    }
    const lastFour = res.data?.lastFour;
    if (!opts.capture || !this.capture) return { cardId, lastFour, detailsCaptured: false };
    const detailsCaptured = await this.captureFromIssue(cardId, res.data!).catch((e: unknown) => {
      this.capture!.log?.(`card ${cardId}: capture at issue failed: ${(e as Error).message}`);
      return false;
    }) || (await this.captureDetails(cardId));
    return { cardId, lastFour, detailsCaptured };
  }

  private async captureFromIssue(cardId: string, data: NonNullable<IssueResponse["data"]>): Promise<boolean> {
    if (typeof data.secureCardDetails !== "string" || !data.secureCardDetails) throw new Error("issue response had no secureCardDetails");
    const { details, scheme } = decryptSecureCardDetails(data.secureCardDetails, this.capture!.keys);
    const lastFour = details.pan.slice(-4);
    await this.store(cardId, details, scheme, "issue", data);
    await this.addBillingDetails(cardId, lastFour);
    return true;
  }

  /**
   * secureCardDetails has no cardholder name or billing address, which hosted checkouts ask for; full-PAN has both
   * (sandbox, 2026-10-19). Best effort: the issue-time capture already stands if this fails.
   */
  private async addBillingDetails(cardId: string, lastFour: string): Promise<void> {
    try {
      const { details, scheme } = await fetchFullCardDetails(this.miden, cardId, this.capture!.keys);
      if (!details.nameOnCard && !details.billingZip && !details.billingAddress) return;
      await this.store(cardId, details, scheme, "full-pan", { lastFour });
    } catch (e) {
      this.capture!.log?.(`card ${cardId}: no billing details from full-PAN: ${(e as Error).message}`);
    }
  }

  /**
   * Captures a card's details from GET .../full-pan if the vault does not have them yet. Safe to repeat.
   * Returns false (and logs why) when Miden will not give them, e.g. a program without full-PAN access.
   */
  async captureDetails(cardId: string, opts: { refreshLastFour?: string } = {}): Promise<boolean> {
    const c = this.capture;
    if (!c) throw new Error("CardService has no vault configured");
    try {
      if (await c.vault.has(cardId)) {
        if (!opts.refreshLastFour) return true;
        // Re-reads the cardholder fields (e.g. a billing address added after the card was captured). The caller
        // passes the stored card's lastFour (this service cannot reveal), so a full-PAN answer for another card is refused.
        await this.addBillingDetails(cardId, opts.refreshLastFour);
        return true;
      }
      const { details, scheme } = await fetchFullCardDetails(this.miden, cardId, c.keys);
      return await this.store(cardId, details, scheme, "full-pan");
    } catch (e) {
      c.log?.(`card ${cardId}: capture from full-PAN failed: ${(e as Error).message}`);
      return false;
    }
  }

  private async store(cardId: string, details: CardDetails, scheme: string, source: CaptureSource, issued?: { firstSix?: string; lastFour?: string }): Promise<boolean> {
    try {
      // The issue response's masked PAN is an independent check that we decrypted this card, not garbage.
      if (issued?.lastFour && !details.pan.endsWith(issued.lastFour)) throw new Error("decrypted PAN does not match the issued lastFour");
      if (issued?.firstSix && !details.pan.startsWith(issued.firstSix)) throw new Error("decrypted PAN does not match the issued firstSix");
      await this.capture!.vault.put(cardId, details, { source });
      this.capture!.log?.(`card ${cardId}: details captured (${source}, ${scheme}, ****${details.pan.slice(-4)})`);
      return true;
    } finally {
      details.pan = details.cvv = "";
    }
  }

  topUp(card: AgentCard, amountCents: number, asset: Stablecoin, idempotencyKey: string): Promise<FundingReceipt> {
    return this.funding.fund({ cardId: card.id, amountCents, asset, idempotencyKey });
  }

  /** See SpendTracker: policy check plus today's running total, in memory. */
  authorize(card: AgentCard, amountCents: number, mcc?: string): AuthorizationResult {
    return this.tracker.authorize(card, amountCents, mcc);
  }
}
