import type { CheckoutFiller, FillRequest, FillResult } from "./CheckoutFiller.js";
import { PlaywrightFiller } from "./PlaywrightFiller.js";
import { ShopifyFiller } from "./ShopifyFiller.js";
import { LemonSqueezyFiller } from "./LemonSqueezyFiller.js";
import { PaddleFiller } from "./PaddleFiller.js";
import { AdaptiveFiller } from "./AdaptiveFiller.js";

/**
 * Picks the filler that knows the page: Stripe Checkout (stripe.com hosts, /c/pay/ links) or a Shopify checkout
 * (/checkouts/... on a myshopify.com host or a shop's own domain). Anything else is refused before a browser opens.
 * Which hosts may be paid at all is the swap's allowlist (SWAP_ALLOWED_HOSTS), not this.
 */
export class RoutingFiller implements CheckoutFiller {
  private readonly fillers: { stripe: CheckoutFiller; shopify: CheckoutFiller; lemonsqueezy: CheckoutFiller; paddle: CheckoutFiller; other?: CheckoutFiller };
  /** Fillers not given are the real ones; tests pass stand-ins for the kinds they exercise. `other` has no default. */
  constructor(fillers: { stripe?: CheckoutFiller; shopify?: CheckoutFiller; lemonsqueezy?: CheckoutFiller; paddle?: CheckoutFiller; other?: CheckoutFiller } = {}) {
    this.fillers = {
      stripe: fillers.stripe ?? new PlaywrightFiller(),
      shopify: fillers.shopify ?? new ShopifyFiller(),
      lemonsqueezy: fillers.lemonsqueezy ?? new LemonSqueezyFiller(),
      paddle: fillers.paddle ?? new PaddleFiller(),
      ...(fillers.other ? { other: fillers.other } : {}),
    };
  }

  /** The default set plus the adaptive filler for every other page. */
  static withAdaptive(adaptive: AdaptiveFiller = new AdaptiveFiller()): RoutingFiller {
    return new RoutingFiller({ other: adaptive });
  }

  fill(req: FillRequest): Promise<FillResult> {
    const kind = checkoutKind(req.url);
    if (kind === "stripe") return this.fillers.stripe.fill(req);
    if (kind === "shopify") return this.fillers.shopify.fill(req);
    if (kind === "lemonsqueezy") return this.fillers.lemonsqueezy.fill(req);
    if (kind === "paddle") return this.fillers.paddle.fill(req);
    if (this.fillers.other) return this.fillers.other.fill(req);
    return Promise.resolve({ outcome: "unsupported_page", submitted: false, detail: "no filler for this kind of checkout page" });
  }
}

export function checkoutKind(url: string): "stripe" | "shopify" | "lemonsqueezy" | "paddle" | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.host === "stripe.com" || u.host.endsWith(".stripe.com") || /^\/c\/pay\//.test(u.pathname)) return "stripe";
  if ((u.host === "lemonsqueezy.com" || u.host.endsWith(".lemonsqueezy.com")) && /^\/checkout\//.test(u.pathname)) return "lemonsqueezy";
  if (/^(?:sandbox-)?pay\.paddle\.io$/.test(u.host) || u.host === "paddle.com" || u.host.endsWith(".paddle.com") || u.searchParams.has("_ptxn")) return "paddle";
  if (/^\/(?:\d+\/)?checkouts\//.test(u.pathname)) return "shopify";
  return undefined;
}
