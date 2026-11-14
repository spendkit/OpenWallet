import type { Browser, Frame, Page } from "playwright-core";
import { parseUsdCents, type CheckoutFiller, type FillRequest, type FillResult, type FillWatcher } from "./CheckoutFiller.js";

/**
 * Fills a Stripe Checkout hosted page (checkout.stripe.com/c/pay/cs_...) in headless Chromium.
 * The selectors are Stripe's own field ids; the local fixture (fixture.ts) mirrors them so tests and the
 * rehearsal script exercise this exact code. Order of work, so the card is exposed as briefly as possible:
 *   load -> bot check? -> read the total, compare -> type the card -> press pay -> watch for the result.
 * After the card is typed, nothing from the page is captured: results are read from URL and fixed selectors only.
 */

export interface PlaywrightFillerOptions {
  headless?: boolean;
  /** How long to wait for the page to load and for the result after pressing pay. */
  loadTimeoutMs?: number;
  resultTimeoutMs?: number;
  /** For tests: an already launched browser (not closed by the filler). */
  browser?: Browser;
}

const SEL = {
  total: '[data-testid="product-summary-total-amount"], #ProductSummary-totalAmount, .ProductSummary-totalAmount',
  cardAccordion: '[data-testid="card-accordion-item-button"]',
  /** The whole accordion row. Stripe's button is 0x0 and takes clicks through a pseudo-element over this row. */
  cardAccordionItem: '[data-testid="card-accordion-item"]',
  email: "#email",
  cardNumber: "#cardNumber",
  cardExpiry: "#cardExpiry",
  cardCvc: "#cardCvc",
  name: "#billingName",
  country: "#billingCountry",
  postal: "#billingPostalCode",
  line1: "#billingAddressLine1",
  line2: "#billingAddressLine2",
  city: "#billingLocality",
  state: "#billingAdministrativeArea",
  submit: '[data-testid="hosted-payment-submit-button"], button.SubmitButton',
  /**
   * Stripe's pay button moves --clickable -> --complete -> --processing -> --success, then redirects to success_url
   * (live test-mode session, 2026-10-19). --complete means "form complete, ready to pay", NOT paid.
   */
  success: ".SubmitButton--success, [data-testid='payment-success']",
  error: '#cardNumber-fieldset .FieldError, .FieldError, [role="alert"], .Notice--error',
};
const THREE_DS_URL = /^https:\/\/hooks\.stripe\.com\/|\/three_d_secure|\/3d_secure/i;
const isPaymentHost = (host: string) => host === "stripe.com" || host.endsWith(".stripe.com") || host.endsWith(".stripe.network");
export const CAPTCHA_FRAME =/hcaptcha\.com|recaptcha|challenges\.cloudflare\.com/i;
export const THREE_DS_FRAME =/three[-_]?d[-_]?secure|\/3ds|3ds2|\bacs\.|\/authenticate|stripe-challenge/i;

export class PlaywrightFiller implements CheckoutFiller {
  constructor(private readonly o: PlaywrightFillerOptions = {}) {}

  async fill(req: FillRequest): Promise<FillResult> {
    const own = !this.o.browser;
    // Loaded on demand: playwright-core is optional, and only the swap needs it.
    const browser = this.o.browser ?? (await (await import("playwright-core")).chromium.launch({ headless: this.o.headless ?? true }));
    // A fresh context per attempt: no cookies, storage or autofill carried between payments.
    const context = await browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    let submitted = false;
    try {
      const page = await context.newPage();
      if (req.watch) await startScreencast(page, req.watch);
      const result = await this.run(page, req, () => (submitted = true));
      req.watch?.step(outcomeLabel(result));
      // Hold the last frame on screen for a moment so a viewer sees the result page.
      if (req.watch) await page.waitForTimeout(1_500).catch(() => undefined);
      return result;
    } catch (e) {
      return { outcome: "error", submitted, detail: cardFree(e, req) };
    } finally {
      await context.close().catch(() => undefined);
      if (own) await browser.close().catch(() => undefined);
    }
  }

  private async run(page: Page, req: FillRequest, markSubmitted: () => void): Promise<FillResult> {
    const loadMs = this.o.loadTimeoutMs ?? 30_000;
    const startHost = new URL(req.url).host;
    const total = page.locator(SEL.total).first();
    const cardField = page.locator(SEL.cardNumber).first();
    // Real Stripe Checkout sometimes never renders in headless Chromium (its bot scoring runs on load). Nothing has
    // been typed yet, so one fresh load is safe.
    const w = req.watch;
    /** Plain fill normally; with a viewer, highlight the field and type it key by key so it can be watched. */
    const put = async (l: ReturnType<Page["locator"]>, value: string, label: string, typed = value) => {
      if (!w) return l.fill(value);
      w.step(label);
      await l.evaluate((el: HTMLElement) => { el.style.outline = "3px solid #635bff"; el.style.outlineOffset = "2px"; }).catch(() => undefined);
      await l.fill("");
      await l.pressSequentially(typed, { delay: 55 });
      await l.evaluate((el: HTMLElement) => { el.style.outline = ""; }).catch(() => undefined);
    };
    w?.step(`Opening the checkout page (${startHost})`);
    let pageAmountCents: number | undefined;
    for (let attempt = 0; attempt < 2 && pageAmountCents === undefined; attempt++) {
      if (attempt === 0) await page.goto(req.url, { waitUntil: "domcontentloaded", timeout: loadMs });
      else await page.reload({ waitUntil: "domcontentloaded", timeout: loadMs });
      // Stripe Checkout is a client-rendered app: wait for the order total (always shown) or the card form.
      await Promise.race([
        total.waitFor({ state: "visible", timeout: loadMs }),
        cardField.waitFor({ state: "attached", timeout: loadMs }),
        page.locator(SEL.cardAccordion).first().waitFor({ state: "attached", timeout: loadMs }),
      ]).catch(() => undefined);
      if (await captchaShown(page)) return { outcome: "captcha", submitted: false, detail: "bot check shown before the card form" };
      // Price check before any card data touches the page. The total's container renders before its text is
      // filled in, so poll briefly for a readable amount.
      pageAmountCents = await readTotal(page, total, Math.min(loadMs, 15_000));
    }
    if (pageAmountCents === undefined) return { outcome: "unsupported_page", submitted: false, detail: "no readable USD total on the page" };
    if (pageAmountCents !== req.expectedAmountCents) {
      return { outcome: "amount_mismatch", submitted: false, pageAmountCents, detail: `page total ${usd(pageAmountCents)}, expected ${usd(req.expectedAmountCents)}` };
    }

    w?.step(`Page total is ${usd(pageAmountCents)}, the agreed price: OK to fill`);
    // Some sessions show payment methods as an accordion; card must be opened first.
    const accordion = page.locator(SEL.cardAccordion).first();
    if ((await accordion.count()) > 0 && !(await cardField.isVisible().catch(() => false))) {
      const row = page.locator(SEL.cardAccordionItem).first();
      await ((await row.count()) > 0 ? row : accordion).click({ timeout: 5_000 });
    }
    if (!(await cardField.isVisible({ timeout: 5_000 }).catch(() => false))) {
      return { outcome: "unsupported_page", submitted: false, pageAmountCents, detail: "card number field not found" };
    }

    const c = req.card;
    const email = page.locator(SEL.email).first();
    if (await isEditable(email)) await put(email, req.email, "Typing the receipt email");
    await put(cardField, digits(c.pan), "Typing the card number");
    const yy = String(c.expYear).slice(-2);
    await put(page.locator(SEL.cardExpiry).first(), `${pad2(c.expMonth)} / ${yy}`, "Typing the expiry date", `${pad2(c.expMonth)}${yy}`);
    await put(page.locator(SEL.cardCvc).first(), digits(c.cvv), "Typing the CVC");
    const name = page.locator(SEL.name).first();
    if (await isEditable(name)) await put(name, c.nameOnCard?.trim() || "Card Holder", "Typing the cardholder name");
    const addr = c.billingAddress;
    const country = page.locator(SEL.country).first();
    if ((await country.count()) > 0) {
      const picked = await country.selectOption(addr?.country || "US").then(() => true, () => false);
      // Never type one country's address into another country's form.
      if (!picked && addr?.country) {
        return { outcome: "unsupported_page", submitted: false, pageAmountCents, detail: `the checkout does not offer the card's billing country (${addr.country})` };
      }
    }
    // Choosing a country can re-render the address block; give it a moment before looking for its fields.
    await page.waitForTimeout(300);
    const postal = page.locator(SEL.postal).first();
    if (await isEditable(postal)) await put(postal, c.billingZip ?? "", "Typing the billing ZIP");
    // Sessions that collect a full billing address show these. Without one on file, stop before paying.
    const line1 = page.locator(SEL.line1).first();
    if (await line1.isVisible().catch(() => false)) {
      if (!addr?.line1 || !addr.city || !c.billingZip) {
        return { outcome: "unsupported_page", submitted: false, pageAmountCents, detail: "the checkout requires a full billing address and none is on file for this card" };
      }
      await line1.fill(addr.line1);
      const line2 = page.locator(SEL.line2).first();
      if (addr.line2 && (await isEditable(line2))) await line2.fill(addr.line2);
      const city = page.locator(SEL.city).first();
      if (await isEditable(city)) await city.fill(addr.city);
      const state = page.locator(SEL.state).first();
      if (addr.state && (await state.isVisible().catch(() => false))) {
        // A select matches on value or label (Miden gives a name, e.g. "Lagos"); a text input takes it as is.
        const isSelect = await state.evaluate((el) => el.tagName === "SELECT").catch(() => false);
        const ok = isSelect
          ? await state.selectOption([{ value: addr.state }, { label: addr.state }]).then((v) => v.length > 0, () => false)
          : await state.fill(addr.state).then(() => true, () => false);
        if (!ok) return { outcome: "unsupported_page", submitted: false, pageAmountCents, detail: `the checkout has no state option matching "${addr.state}"` };
      }
    }
    // From here on, never read the page's content: only URL, frames and fixed selectors.

    const submit = page.locator(SEL.submit).first();
    // Stripe ignores a press until the button is ready (--complete): tax and address updates may still be in flight.
    if (!(await submitReady(submit, 15_000))) {
      return { outcome: "unsupported_page", submitted: false, pageAmountCents, detail: "the pay button never became ready; the page may want a field we do not have" };
    }
    if (await captchaShown(page)) return { outcome: "captcha", submitted: false, pageAmountCents, detail: "bot check shown before submit" };
    markSubmitted();
    w?.step("Pressing Pay");
    await submit.click({ timeout: 10_000 });
    return this.watch(page, startHost, pageAmountCents);
  }

  /** After pressing pay: success redirect or state, a decline message, a challenge, or a timeout (unknown). */
  private async watch(page: Page, startHost: string, pageAmountCents: number): Promise<FillResult> {
    const deadline = Date.now() + (this.o.resultTimeoutMs ?? 60_000);
    const done = (outcome: FillResult["outcome"], detail: string): FillResult => ({ outcome, submitted: true, pageAmountCents, detail });
    while (Date.now() < deadline) {
      const host = safeHost(page.url());
      // Stripe's own hosts (hooks.stripe.com is its 3-D Secure redirect) are never the merchant's success page.
      if (host && THREE_DS_URL.test(page.url())) return done("three_ds", "redirected to a 3-D Secure page after submit");
      if (host && host !== startHost && !isPaymentHost(host)) return done("succeeded", `redirected to ${host}`);
      if (await page.locator(SEL.success).first().isVisible().catch(() => false)) return done("succeeded", "page shows payment succeeded");
      if (hasFrame(page, THREE_DS_FRAME)) return done("three_ds", "issuer 3-D Secure challenge shown after submit");
      if (await captchaShown(page)) return done("captcha", "bot check shown after submit");
      const err = page.locator(SEL.error).first();
      if (await err.isVisible().catch(() => false)) {
        // Only the decline wording is matched; the message itself is not stored (it can echo field content).
        const text = (await err.innerText().catch(() => "")).toLowerCase();
        if (/declin|insufficient|do not honou?r|not supported|incorrect|invalid/.test(text)) return done("declined", "page shows a card decline");
      }
      await page.waitForTimeout(500);
    }
    return done("error", "no result shown before the timeout; the charge state is unknown");
  }
}

/** Streams the page to a viewer as JPEG frames over the Chrome DevTools screencast. Ends with the context. */
export async function startScreencast(page: Page, watch: FillWatcher): Promise<void> {
  const cdp = await page.context().newCDPSession(page).catch(() => undefined);
  if (!cdp) return;
  cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number }) => {
    watch.frame(f.data);
    void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => undefined);
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1000, maxHeight: 900, everyNthFrame: 1 }).catch(() => undefined);
}

export function outcomeLabel(r: FillResult): string {
  if (r.outcome === "succeeded") return "Payment succeeded";
  if (r.outcome === "declined") return "The card was declined";
  return `Stopped: ${r.outcome.replace(/_/g, " ")}${r.detail ? ` (${r.detail})` : ""}`;
}

export function hasFrame(page: Page, re: RegExp): boolean {
  return page.frames().some((f: Frame) => f !== page.mainFrame() && (re.test(f.url()) || re.test(f.name())));
}
/** Ready when Stripe marks the button --complete; a button with no Stripe state classes at all is taken as ready. */
async function submitReady(submit: ReturnType<Page["locator"]>, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const cls = (await submit.getAttribute("class", { timeout: 2_000 }).catch(() => null)) ?? "";
    if (/\bSubmitButton--complete\b/.test(cls) || !/\bSubmitButton--/.test(cls)) return true;
    if (Date.now() >= deadline) return false;
    await submit.page().waitForTimeout(250);
  }
}

async function readTotal(page: Page, total: ReturnType<Page["locator"]>, waitMs: number): Promise<number | undefined> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const text = (await total.count()) > 0 ? await total.innerText({ timeout: 2_000 }).catch(() => "") : "";
    const cents = parseUsdCents(text);
    if (cents !== undefined || Date.now() >= deadline) return cents;
    await page.waitForTimeout(250);
  }
}

/**
 * A bot check the user would see. Real Stripe Checkout always loads an invisible hCaptcha in a hidden 1px frame
 * (it only becomes visible when it decides to challenge), so a captcha frame counts only if it and every frame
 * around it are rendered at a usable size.
 */
export async function captchaShown(page: Page): Promise<boolean> {
  for (const f of page.frames()) {
    if (f === page.mainFrame() || !(CAPTCHA_FRAME.test(f.url()) || CAPTCHA_FRAME.test(f.name()))) continue;
    if (await frameVisible(f)) return true;
  }
  return false;
}
async function frameVisible(f: Frame): Promise<boolean> {
  for (let cur: Frame | null = f; cur && cur.parentFrame(); cur = cur.parentFrame()) {
    const el = await cur.frameElement().catch(() => null);
    const box = el && (await el.boundingBox().catch(() => null));
    const shown = el && (await el.isVisible().catch(() => false));
    if (!box || !shown || box.width < 50 || box.height < 50) return false;
  }
  return true;
}
export async function isEditable(l: ReturnType<Page["locator"]>): Promise<boolean> {
  return (await l.count()) > 0 && (await l.isEditable().catch(() => false));
}
export const digits = (s: string) => s.replace(/\D/g, "");
export const pad2 = (v: string | number) => String(v).padStart(2, "0").slice(-2);
export const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
export const safeHost =(u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return undefined;
  }
};

/** An error's message with any card value or long digit run removed, and cut short. */
export function cardFree(e: unknown, req: Pick<FillRequest, "card">): string {
  let s = e instanceof Error ? `${e.name}: ${e.message.split("\n")[0]}` : String(e);
  for (const v of [req.card.pan, digits(req.card.pan), req.card.cvv]) if (v && v.length >= 3) s = s.split(v).join("[redacted]");
  return s.replace(/\d[\d\s-]{10,}\d/g, "[redacted]").slice(0, 200);
}
