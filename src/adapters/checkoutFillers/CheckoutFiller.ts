/**
 * The part of a checkout swap that touches a merchant's hosted payment page. A filler gets the card details
 * for one attempt only, must check the page's price before typing anything, and reports what happened
 * without page content: after the card fields are filled, no DOM dump, no screenshot, no field values.
 */

import type { CardDetails } from "../cardVault/CardVault.js";
export type { CardDetails };

export type FillOutcome =
  /** The page confirmed the payment (redirected to the merchant's success URL or showed its success state). */
  | "succeeded"
  /** The page said the card was declined. */
  | "declined"
  /** The page's total is not the price the agent agreed to: stopped before typing the card. */
  | "amount_mismatch"
  /** A bot check (hCaptcha etc.). */
  | "captcha"
  /** A 3-D Secure challenge from the card issuer, after submission. */
  | "three_ds"
  /** Not a page we know how to fill (no card fields found). */
  | "unsupported_page"
  /** Anything else: timeout, navigation error, unknown state. */
  | "error";

export interface FillResult {
  outcome: FillOutcome;
  /**
   * True once the pay button was pressed. False guarantees this attempt cannot have charged the card;
   * true with any outcome but "succeeded" or "declined" means the charge state is unknown.
   */
  submitted: boolean;
  /** Short and card-free, e.g. "page total $12.00, expected $10.00". */
  detail?: string;
  /** The total the page showed, in cents, when it could be read. */
  pageAmountCents?: number;
}

export interface FillRequest {
  url: string;
  expectedAmountCents: number;
  card: CardDetails;
  /** Receipt email for pages that require one (Stripe Checkout does). */
  email: string;
  /**
   * Live view of the attempt (steps and screen frames). Only ever set when the card is Stripe's public 4242 test card
   * (SWAP_STRIPE_TEST_CARD on a test-mode link): with a real card, nothing from the page may be captured.
   */
  watch?: FillWatcher;
}

export interface FillWatcher {
  /** A short, human-readable step, e.g. "Typing the card number". */
  step(label: string): void;
  /** One JPEG frame of the page, base64. */
  frame(jpegBase64: string): void;
}

export interface CheckoutFiller {
  fill(req: FillRequest): Promise<FillResult>;
}

/**
 * Overwrites the details object's fields once an attempt is over. JS strings are immutable, so this cannot wipe
 * the old values from memory; it drops our references so nothing downstream (a log, an error, a retry) holds them.
 */
export function scrub(card: CardDetails | null | undefined): void {
  if (!card) return;
  card.pan = "";
  card.cvv = "";
  card.expMonth = 0;
  card.expYear = 0;
  if (card.nameOnCard !== undefined) card.nameOnCard = "";
  if (card.billingZip !== undefined) card.billingZip = "";
  if (card.billingAddress) card.billingAddress = { line1: "", city: "", country: "" };
}

/** "$1,234.50" / "US$10.00" / "10.00 USD" -> 123450; undefined when no dollar amount is present. Other dollars ("CA$10.00") are not USD. */
export function parseUsdCents(text: string): number | undefined {
  const m = /(?<![A-Za-z])(?:US)?\$\s*([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)\s*USD/i.exec(text);
  const raw = m?.[1] ?? m?.[2];
  if (!raw) return undefined;
  const [whole, frac = ""] = raw.replace(/,/g, "").split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : undefined;
}

/** Last four of a PAN, the only card data that may appear in a log or a view. */
export const lastFour = (pan: string) => pan.replace(/\D/g, "").slice(-4);
