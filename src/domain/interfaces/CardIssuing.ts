import type { SpendPolicy } from "../../lib/services/spendPolicy.js";
import type { FundingReceipt, Stablecoin } from "./FundingSource.js";

// The card-issuing port: everything the core needs from whoever issues the cards (Miden, a mock, another issuer).
// Providers live in src/adapters/providers/<name>/ and are chosen in bootstrap.ts.

/** A verified person or business at the provider. An agent cannot be the KYC subject. */
export interface CardholderKyc {
  customerId: string;
  /** A credential: never log it. */
  kycToken: string;
}

/** Individual KYC by ID document. `idType` is the provider's enum, e.g. PASSPORT. */
export interface IndividualKyc {
  firstName: string;
  lastName: string;
  /** YYYY-MM-DD */
  dateOfBirth: string;
  idType: string;
  idNumber: string;
  /** Base64 or data URI. */
  idFrontImage: string;
  phone: string;
  email: string;
  address: { address1: string; city: string; state: string; zipcode: string; country: string };
}

export interface AgentCard {
  id: string;
  agentId: string;
  policy: SpendPolicy;
  /** Set when a vault is configured: whether the full card details are in it. */
  detailsCaptured?: boolean;
}

export type AuthorizationResult = { ok: true } | { ok: false; reason: string };

export interface CardTransaction {
  id?: number;
  cardId?: string;
  transactionType?: string;
  transactionStatus?: string;
  transactionReference?: string;
  transactionAmount?: number;
  merchantName?: string;
  merchantMcc?: string;
  merchantMid?: string;
  /** UTC; a provider may omit the zone suffix, e.g. "2026-10-19T14:11:54.689346". */
  transactionTime?: string;
  authCode?: string;
}

/** Reads and KYC on the provider's side. Failures throw the classes in domain/errors/CardProviderErrors. */
export interface CardLifecyclePort {
  /** Starts KYC. `reference` is unique per attempt. Returns the provider's status when it gives one. */
  submitKyc(reference: string, kyc: IndividualKyc): Promise<{ kycStatus?: string }>;
  kycStatus(clientReference: string): Promise<{ status: string; customerId?: string; kycToken?: string }>;
  /** Dollars. */
  cardBalance(cardId: string): Promise<number>;
  transactions(cardId: string, type?: string, pageSize?: number): Promise<CardTransaction[]>;
  /** Sandbox only: a simulated purchase. Not idempotent on every provider: never retry blindly. `idempotencyKey` is ours; the provider derives its own header from it. Returns the provider's authorization id. */
  simulateAuthorization(
    args: { cardId: string; amountDollars: number; mcc?: string; merchantName?: string; approve?: boolean; mid?: string },
    opts?: { idempotencyKey?: string },
  ): Promise<string | undefined>;
}

/** Issues cards and keeps their details. */
export interface CardIssuerPort {
  issue(agentId: string, policy: SpendPolicy, kyc: CardholderKyc, clientReference: string, initialBalanceDollars?: number): Promise<AgentCard>;
  issueOneTime(
    kyc: CardholderKyc, amountCents: number, clientReference: string,
    opts: { capture: boolean; terminateInDays?: number },
  ): Promise<{ cardId: string; lastFour?: string; detailsCaptured: boolean }>;
  /** Fetches and vaults the card's details if the vault lacks them. Safe to repeat. */
  captureDetails(cardId: string, opts?: { refreshLastFour?: string }): Promise<boolean>;
  topUp(card: AgentCard, amountCents: number, asset: Stablecoin, idempotencyKey: string): Promise<FundingReceipt>;
  authorize(card: AgentCard, amountCents: number, mcc?: string): AuthorizationResult;
}
