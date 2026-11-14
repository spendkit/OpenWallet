import { createHash } from "node:crypto";
import { MidenApiError, type MidenClient } from "../../lib/clients/cardIssuing/miden/MidenClient.js";
import { DuplicateReferenceError } from "../../domain/errors/CardProviderErrors.js";
import type { FundingReceipt, FundingRequest, FundingSource } from "../../domain/interfaces/FundingSource.js";

/** Miden's 400 body when a Reference was already used in the last 24h (docs: Idempotency in Miden APIs). */
const DUPLICATE_REFERENCE = /already been seen/i;

/** The Reference was already processed: the first call went through, so look the top-up up instead of retrying. */
export class MidenDuplicateReferenceError extends DuplicateReferenceError {
  constructor(idempotencyKey: string, cause: MidenApiError) {
    super(idempotencyKey, `Miden top-up ${idempotencyKey} was already processed; reconcile via GET api/v1/cards/transactions`, { cause });
    this.name = "MidenDuplicateReferenceError";
  }
}

interface TopUpResponse {
  isSuccessful?: boolean;
  responseCode?: string;
  responseMessage?: string;
  cardTransactionId?: number;
}

/**
 * Moves fiat from our Miden USD wallet to a card: PATCH api/v1/cards/topup
 * (docs/miden-api.md). The stablecoin has already been credited 1:1 in our own
 * ledger, so `asset` is not sent to Miden.
 *
 * `idempotencyKey` is sent as the `Reference` header (Miden's 24h idempotency
 * key) and as `clientReference`. Retry after a timeout/5xx with the same key and
 * the same amount. If Miden answers "already seen", the first attempt landed, and
 * we throw MidenDuplicateReferenceError rather than invent a receipt.
 */
export class MidenWalletFunding implements FundingSource {
  constructor(private readonly miden: MidenClient) {}

  async fund(req: FundingRequest): Promise<FundingReceipt> {
    if (!Number.isInteger(req.amountCents) || req.amountCents <= 0) {
      throw new RangeError(`amountCents must be a positive integer, got ${req.amountCents}`);
    }
    let res: TopUpResponse;
    try {
      res = await this.miden.request<TopUpResponse>(
        "PATCH",
        "/api/v1/cards/topup",
        {
          cardId: req.cardId,
          // Major units (dollars). Inferred from the docs example; UNCONFIRMED until the sandbox.
          amount: req.amountCents / 100,
          clientReference: req.idempotencyKey,
          walletCurrency: "USD",
        },
        { reference: referenceFor(req.idempotencyKey) },
      );
    } catch (e) {
      if (e instanceof MidenApiError && e.status === 400 && DUPLICATE_REFERENCE.test(e.body)) {
        throw new MidenDuplicateReferenceError(req.idempotencyKey, e);
      }
      throw e;
    }
    // HTTP 200 does not imply business success: check isSuccessful / responseCode "000".
    const ok = res.isSuccessful === true && res.responseCode === "000";
    return {
      id: res.cardTransactionId !== undefined ? String(res.cardTransactionId) : req.idempotencyKey,
      status: ok ? "confirmed" : "failed",
    };
  }
}

/** Stable 20-char hex Reference (the length the docs' samples use) derived from the caller's key. */
export function referenceFor(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 20);
}
