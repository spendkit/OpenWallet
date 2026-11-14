// Failures every card-issuing provider reports the same way, so the core never needs to know which provider it is
// talking to. A provider's own error classes extend these.

/** The provider answered with a non-2xx HTTP status. `body` is the raw response text (it may echo request data: never log it). */
export class CardProviderApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) {
    super(message);
    this.name = "CardProviderApiError";
  }
}

/** The provider answered successfully at the transport level but said no: a definite refusal, not a timeout. */
export class CardProviderBusinessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CardProviderBusinessError";
  }
}

/** The provider has already processed this idempotency key: the first call went through, so look it up instead of retrying. */
export class DuplicateReferenceError extends Error {
  constructor(readonly idempotencyKey: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DuplicateReferenceError";
  }
}

/** A 4xx other than 429: the provider refused for certain (a timeout, 429 or 5xx may still have gone through). */
export function isDefiniteRefusal(e: unknown): boolean {
  if (e instanceof CardProviderBusinessError) return true;
  return e instanceof CardProviderApiError && e.status >= 400 && e.status < 500 && e.status !== 429;
}

/** A readable reason from a provider error body ("117 Insufficient wallet balance"), or just the HTTP status. */
export function providerMessage(e: CardProviderApiError): string {
  try {
    const b = JSON.parse(e.body) as { responseMessage?: string; message?: string; responseCode?: string };
    return `${b.responseCode ? b.responseCode + " " : ""}${b.responseMessage ?? b.message ?? `HTTP ${e.status}`}`;
  } catch {
    return `HTTP ${e.status}`;
  }
}
