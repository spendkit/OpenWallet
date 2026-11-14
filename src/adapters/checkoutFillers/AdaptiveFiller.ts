import type { Browser, Page } from "playwright-core";
import type { CheckoutFiller, FillRequest, FillResult } from "./CheckoutFiller.js";
import { THREE_DS_FRAME, captchaShown, cardFree, hasFrame, safeHost, startScreencast, outcomeLabel, usd } from "./PlaywrightFiller.js";
import {
  CARD_KINDS, classify, isButtonLike, isPrivateHost, isTextInput, locate, looksLikePay, readTotals, scanFields, totalsMatch, valueFor,
  type FieldKind, type ScannedField,
} from "./formScan.js";
import type { FormPlan, FormPlanner } from "./FormPlanner.js";

/**
 * Pays a checkout page we have no filler for. Two ways to understand the form, tried in order:
 *  1. Labels: the fields' own autocomplete tokens, names and labels (cc-number, "Card number", "CVC"...). No model.
 *  2. A planning model (FormPlanner), when the labels are not enough: it sees the controls and a screenshot taken
 *     before any card data is typed, and answers with stand-ins per field. Every answer is checked against the page
 *     (card stand-ins only into card-shaped inputs of the payment form, each at most once, real buttons) before use.
 * The price is read from the page and must equal the agreed price before anything is typed. After the card is typed,
 * nothing from the page goes anywhere: the result is judged from the URL, frames and fixed wording only.
 *
 * Unfamiliar pages are only ever paid with a one-time card holding exactly the agreed amount (SwapInteractor), or
 * Stripe's test card on a test host, so a page or a plan that goes wrong cannot take more than that.
 */

export interface AdaptiveFillerOptions {
  headless?: boolean;
  loadTimeoutMs?: number;
  resultTimeoutMs?: number;
  /** For tests: an already launched browser (not closed by the filler). */
  browser?: Browser;
  /** Without one, only forms whose labels are clear can be paid. */
  planner?: FormPlanner;
  /** Pages of a multi-step checkout to walk before the card fields must appear. */
  maxRounds?: number;
  log?: (msg: string) => void;
}

interface Resolved {
  cardHere: boolean;
  fills: { field: ScannedField; kind: FieldKind }[];
  checks: ScannedField[];
  pay?: ScannedField;
  next?: ScannedField;
  source: "labels" | "model";
}

const THREE_DS_URL = /\/three_d_secure|\/3d_secure|\/3ds\b|\/authenticate|acs\./i;
const SUCCESS_URL = /success|thank|confirm(ed|ation)|complete|receipt|order[-_/]?(placed|received)/i;
const SUCCESS_TEXT = /payment (was )?(successful|succeeded|complete|received|confirmed)|thanks? (you )?for (your )?(order|purchase|payment)|order (is |has been )?(confirmed|complete|placed|received)/i;
const DECLINE_TEXT = /declin|insufficient funds|card (was |has been )?(refused|rejected|denied)|do not honou?r|payment (has )?failed|could not be processed/i;
/** Boxes never ticked, whatever a plan says. */
const NEVER_TICK = /subscri|newsletter|marketing|save (my |this )?(card|payment)|remember (me|my)|recurring|auto-?renew|add (an? )?(extra|protection|insurance|warranty|donat)|tip\b/i;

export class AdaptiveFiller implements CheckoutFiller {
  constructor(private readonly o: AdaptiveFillerOptions = {}) {}

  async fill(req: FillRequest): Promise<FillResult> {
    const own = !this.o.browser;
    const browser = this.o.browser ?? (await (await import("playwright-core")).chromium.launch({ headless: this.o.headless ?? true }));
    const context = await browser.newContext({ locale: "en-US", serviceWorkers: "block", viewport: { width: 1000, height: 900 } });
    const startHost = safeHost(req.url) ?? "";
    // The page runs in our server's browser: it may not reach this machine or a private network (only the start host,
    // which SwapInteractor has already vetted, e.g. a local test shop).
    await context.route("**/*", (route) => {
      const h = safeHost(route.request().url());
      return h && h !== startHost && isPrivateHost(h) ? route.abort("blockedbyclient") : route.continue();
    });
    let submitted = false;
    try {
      const page = await context.newPage();
      if (req.watch) await startScreencast(page, req.watch);
      const result = await this.run(page, req, () => (submitted = true));
      req.watch?.step(outcomeLabel(result));
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
    const w = req.watch;
    const host = safeHost(req.url) ?? "?";
    const stop = (outcome: FillResult["outcome"], detail: string, pageAmountCents?: number): FillResult =>
      ({ outcome, submitted: false, detail, ...(pageAmountCents !== undefined ? { pageAmountCents } : {}) });

    w?.step(`Opening the checkout page (${host})`);
    await page.goto(req.url, { waitUntil: "load", timeout: loadMs });
    await settle(page);
    if (await captchaShown(page)) return stop("captcha", "bot check shown before the card form");

    // The agreed price must be on the first page, before anything is typed.
    const first = totalsMatch(await readTotals(page), req.expectedAmountCents);
    if (!first.ok) {
      return first.shown !== undefined
        ? stop("amount_mismatch", `page total ${usd(first.shown)}, expected ${usd(req.expectedAmountCents)}`, first.shown)
        : stop("unsupported_page", "no readable USD total on the page");
    }
    w?.step(`Page total is ${usd(req.expectedAmountCents)}, the agreed price: OK to fill`);

    const rounds = this.o.maxRounds ?? 3;
    for (let round = 1; round <= rounds; round++) {
      const fields = await scanFields(page);
      let plan: Resolved | string = labelPlan(fields, req);
      if (typeof plan === "string") {
        if (!this.o.planner) return stop("unsupported_page", `the form's labels are not clear enough (${plan})`, req.expectedAmountCents);
        w?.step("Unfamiliar form: asking the model which field is which (it never sees the card)");
        // Taken now, while no card data has been typed on this page or any before it.
        const shot = (await page.screenshot({ type: "jpeg", quality: 60 }).catch(() => undefined))?.toString("base64");
        let raw: FormPlan;
        try {
          raw = await this.o.planner.plan({
            host, title: (await page.title().catch(() => "")).slice(0, 120), expectedAmountCents: req.expectedAmountCents, round,
            fields: fields.map(({ frame: _f, ...info }) => info), ...(shot ? { screenshotJpeg: shot } : {}),
          });
        } catch (e) {
          return stop("unsupported_page", `could not map the form (${(e as Error).message.slice(0, 120)})`, req.expectedAmountCents);
        }
        plan = checkPlan(raw, fields, req);
        if (typeof plan === "string") {
          this.o.log?.(`adaptive fill on ${host}: plan refused: ${plan}`);
          return stop("unsupported_page", `the form map was refused: ${plan}`, req.expectedAmountCents);
        }
      }
      this.o.log?.(`adaptive fill on ${host}: round ${round}, fields from ${plan.source}, ${plan.cardHere ? "card form" : "continue"}`);
      w?.step(plan.source === "labels" ? "Recognised the form from its field labels" : "The model mapped the form; checked it against the page");

      if (!plan.cardHere) {
        const r = await this.fillAll(page, plan, req, false);
        if (r) return stop("unsupported_page", r, req.expectedAmountCents);
        w?.step("Continuing to the next step");
        await locate(plan.next!).click({ timeout: 10_000 });
        await settle(page);
        if (await captchaShown(page)) return stop("captcha", "bot check shown before the card form");
        const again = totalsMatch(await readTotals(page), req.expectedAmountCents);
        if (!again.ok && again.shown !== undefined) return stop("amount_mismatch", `page total ${usd(again.shown)} after continuing, expected ${usd(req.expectedAmountCents)}`, again.shown);
        continue;
      }

      // Last look at the price on the page that takes the card (shipping or tax may have been added).
      const last = totalsMatch(await readTotals(page), req.expectedAmountCents);
      if (!last.ok && last.shown !== undefined) return stop("amount_mismatch", `page total ${usd(last.shown)}, expected ${usd(req.expectedAmountCents)}`, last.shown);
      const startUrl = page.url();
      const before = await bodyText(page);
      const r = await this.fillAll(page, plan, req, true);
      if (r) return stop("unsupported_page", r, req.expectedAmountCents);
      // From here on, never read the page's content into anything kept: only URL, frames and fixed wording.
      if (await captchaShown(page)) return stop("captcha", "bot check shown before submit", req.expectedAmountCents);
      const pay = locate(plan.pay!);
      if (!(await waitEnabled(pay, 10_000))) return stop("unsupported_page", "the pay button never became ready; the page may want a field we do not have", req.expectedAmountCents);
      markSubmitted();
      w?.step("Pressing Pay");
      await pay.click({ timeout: 10_000 });
      return this.watch(page, startUrl, { success: SUCCESS_TEXT.test(before), decline: DECLINE_TEXT.test(before) }, req.expectedAmountCents);
    }
    return stop("unsupported_page", `no card form after ${rounds} steps`, req.expectedAmountCents);
  }

  /** Fills the plan's fields (card ones only when withCard), ticks its boxes. Returns a reason when it cannot. */
  private async fillAll(page: Page, plan: Resolved, req: FillRequest, withCard: boolean): Promise<string | undefined> {
    const w = req.watch;
    // Contact and address first, the card last, so the card is on the page for as short a time as possible.
    const ordered = [...plan.fills].sort((a, b) => Number(CARD_KINDS.has(a.kind)) - Number(CARD_KINDS.has(b.kind)));
    for (const { field, kind } of ordered) {
      if (CARD_KINDS.has(kind) && !withCard) continue;
      const v = valueFor(kind, field, req.card, req.email);
      if (!v) {
        if (field.required) return `the checkout requires ${kind.replace(/_/g, " ")} and none is on file for this card`;
        continue;
      }
      const l = locate(field);
      if ("select" in v) {
        let picked = false;
        for (const want of v.select) {
          picked = await l.selectOption({ value: want }, { timeout: 3_000 }).then((x) => x.length > 0, () => false)
            || await l.selectOption({ label: want }, { timeout: 3_000 }).then((x) => x.length > 0, () => false);
          if (picked) break;
        }
        if (!picked) return `no ${kind.replace(/_/g, " ")} option matching the card's details`;
        continue;
      }
      if (w) {
        w.step(STEP_LABEL[kind]);
        await l.evaluate((el: HTMLElement) => { el.style.outline = "3px solid #635bff"; el.style.outlineOffset = "2px"; }).catch(() => undefined);
      }
      await l.click({ timeout: 5_000 }).catch(() => undefined);
      await l.fill("", { timeout: 5_000 }).catch(() => undefined);
      await l.pressSequentially(v.type, { delay: w ? 55 : 10, timeout: 15_000 });
      if (w) await l.evaluate((el: HTMLElement) => { el.style.outline = ""; }).catch(() => undefined);
    }
    for (const box of plan.checks) {
      w?.step(`Ticking "${(box.label || box.name || "a required box").slice(0, 50)}"`);
      const l = locate(box);
      const ok = await l.check({ timeout: 5_000 }).then(() => true, () => false) || await l.check({ force: true, timeout: 5_000 }).then(() => true, () => false);
      if (!ok) return "could not tick a required box";
    }
    await page.waitForTimeout(300);
    return undefined;
  }

  /** After pressing pay: success, a decline, a challenge, or no answer (unknown: the money is held, never assumed failed). */
  private async watch(page: Page, startUrl: string, before: { success: boolean; decline: boolean }, cents: number): Promise<FillResult> {
    const deadline = Date.now() + (this.o.resultTimeoutMs ?? 60_000);
    const done = (outcome: FillResult["outcome"], detail: string): FillResult => ({ outcome, submitted: true, pageAmountCents: cents, detail });
    const startPath = pathOf(startUrl);
    while (Date.now() < deadline) {
      const url = page.url();
      if (THREE_DS_URL.test(url) || hasFrame(page, THREE_DS_FRAME)) return done("three_ds", "3-D Secure challenge shown after submit");
      if (await captchaShown(page)) return done("captcha", "bot check shown after submit");
      if (url !== startUrl && SUCCESS_URL.test(pathOf(url)) && !SUCCESS_URL.test(startPath)) return done("succeeded", `went to a confirmation page on ${safeHost(url)}`);
      // Wording only, matched here and dropped: the text itself is never stored (it can echo field content).
      const text = await bodyText(page);
      if (!before.success && SUCCESS_TEXT.test(text)) return done("succeeded", "page shows the payment went through");
      if (!before.decline && DECLINE_TEXT.test(text)) return done("declined", "page shows a card decline");
      await page.waitForTimeout(500);
    }
    return done("error", "no result shown before the timeout; the charge state is unknown");
  }
}

const STEP_LABEL: Record<FieldKind, string> = {
  card_number: "Typing the card number", card_expiry: "Typing the expiry date", card_exp_month: "Choosing the expiry month",
  card_exp_year: "Choosing the expiry year", card_cvc: "Typing the CVC", cardholder_name: "Typing the cardholder name",
  email: "Typing the receipt email", billing_postal_code: "Typing the billing ZIP", billing_address_line1: "Typing the billing address",
  billing_city: "Typing the city", billing_state: "Typing the state", billing_country: "Choosing the country",
};

/**
 * Route 1: the fields say what they are. Needs one card number, one CVC, an expiry (one box or month + year), exactly
 * one pay button, and nothing required that we cannot fill. Returns why not, otherwise the plan.
 */
export function labelPlan(fields: ScannedField[], req: Pick<FillRequest, "card" | "email">): Resolved | string {
  const fills: Resolved["fills"] = [];
  const seen = new Map<FieldKind, number>();
  const unknownRequired: ScannedField[] = [];
  for (const f of fields) {
    if (f.disabled || isButtonLike(f)) continue;
    const kind = classify(f);
    if (!kind) {
      if (f.required) unknownRequired.push(f);
      continue;
    }
    seen.set(kind, (seen.get(kind) ?? 0) + 1);
    fills.push({ field: f, kind });
  }
  for (const k of CARD_KINDS) if ((seen.get(k) ?? 0) > 1) return `more than one ${k.replace(/_/g, " ")} field`;
  if (!seen.has("card_number")) return "no labelled card number field";
  if (!seen.has("card_cvc")) return "no labelled CVC field";
  if (!seen.has("card_expiry") && !(seen.has("card_exp_month") && seen.has("card_exp_year"))) return "no labelled expiry field";
  if (unknownRequired.length) return `required field(s) we cannot place: ${unknownRequired.map((f) => f.label || f.name || f.type).slice(0, 3).join(", ")}`;
  for (const { field, kind } of fills) if (field.required && !valueFor(kind, field, req.card, req.email)) return `required ${kind.replace(/_/g, " ")} with nothing on file`;
  const number = fills.find((x) => x.kind === "card_number")!.field;
  let pays = fields.filter((f) => looksLikePay(f) && !f.disabled);
  if (pays.length > 1 && number.ref.startsWith("0.") && number.form >= 0) pays = pays.filter((p) => p.ref.startsWith("0.") && p.form === number.form);
  if (pays.length !== 1) return pays.length ? "more than one pay button" : "no pay button";
  return { cardHere: true, fills, checks: [], pay: pays[0]!, source: "labels" };
}

/**
 * Route 2: a model's plan, checked against the page. The model never sees the card, but a page can try to steer it,
 * so a plan may only put card data into card-shaped inputs of the payment form, once each.
 */
export function checkPlan(plan: FormPlan, fields: ScannedField[], req: Pick<FillRequest, "card" | "email">): Resolved | string {
  if (plan.cannotPay) return `the page cannot be paid as is (${plan.cannotPay.slice(0, 120)})`;
  const byRef = new Map(fields.map((f) => [f.ref, f]));
  const used = new Set<string>();
  const fills: Resolved["fills"] = [];
  const count = new Map<FieldKind, number>();
  for (const { ref, value } of plan.fields) {
    const f = byRef.get(ref);
    if (!f) return `unknown field ${ref}`;
    if (used.has(ref)) return `field ${ref} mapped twice`;
    used.add(ref);
    if (f.disabled || isButtonLike(f) || f.tag === "textarea" && CARD_KINDS.has(value)) return `field ${ref} cannot take ${value}`;
    if (f.tag === "input" && (f.type === "checkbox" || f.type === "radio")) return `field ${ref} is a ${f.type}`;
    if (CARD_KINDS.has(value)) {
      const selectOk = (value === "card_exp_month" || value === "card_exp_year") && f.tag === "select";
      if (!isTextInput(f) && !selectOk) return `card data (${value}) may only go into a text input, not ${f.tag}${f.type ? `[${f.type}]` : ""}`;
      // The page's own labels win: card data never goes into a field that says it is something else.
      const says = classify(f);
      if (says && !CARD_KINDS.has(says)) return `the plan puts ${value} into a field labelled as ${says}`;
      if (value === "card_number" && f.maxLength !== null && f.maxLength < 12) return "card number field too short";
      if (value === "card_cvc" && f.maxLength !== null && f.maxLength < 3) return "CVC field too short";
    }
    count.set(value, (count.get(value) ?? 0) + 1);
    fills.push({ field: f, kind: value });
  }
  for (const k of CARD_KINDS) if ((count.get(k) ?? 0) > 1) return `${k} mapped to more than one field`;
  const checks: ScannedField[] = [];
  for (const ref of plan.checkboxes) {
    const f = byRef.get(ref);
    if (!f || f.tag !== "input" || f.type !== "checkbox") return `checkbox ${ref} is not a checkbox`;
    if (NEVER_TICK.test(`${f.label} ${f.name} ${f.id}`)) continue;
    checks.push(f);
  }
  const anyCard = [...CARD_KINDS].some((k) => count.has(k));
  if (!plan.cardFieldsOnThisPage) {
    if (anyCard) return "card data planned on a page said to have no card form";
    const next = plan.continueButtonRef ? byRef.get(plan.continueButtonRef) : undefined;
    if (!next || !isButtonLike(next)) return "no continue button";
    return { cardHere: false, fills, checks, next, source: "model" };
  }
  if (!count.has("card_number") || !count.has("card_cvc")) return "the plan has no card number or no CVC";
  if (!count.has("card_expiry") && !(count.has("card_exp_month") && count.has("card_exp_year"))) return "the plan has no expiry";
  const pay = plan.payButtonRef ? byRef.get(plan.payButtonRef) : undefined;
  if (!pay || !isButtonLike(pay)) return "no pay button";
  // On the page itself (frame 0), the card must go into the same form the pay button submits.
  if (pay.ref.startsWith("0.") && pay.form >= 0) {
    for (const { field, kind } of fills) {
      if (CARD_KINDS.has(kind) && field.ref.startsWith("0.") && field.form !== pay.form) return `${kind} is outside the form the pay button submits`;
    }
  }
  for (const { field, kind } of fills) if (field.required && !valueFor(kind, field, req.card, req.email)) return `required ${kind.replace(/_/g, " ")} with nothing on file`;
  return { cardHere: true, fills, checks, pay, source: "model" };
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(300);
}
async function bodyText(page: Page): Promise<string> {
  return page.mainFrame().evaluate(() => document.body?.innerText ?? "").catch(() => "");
}
async function waitEnabled(l: ReturnType<Page["locator"]>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await l.isEnabled().catch(() => false)) return true;
    if (Date.now() >= deadline) return false;
    await l.page().waitForTimeout(250);
  }
}
const pathOf = (u: string) => {
  try {
    const x = new URL(u);
    return `${x.pathname}${x.search}`;
  } catch {
    return "";
  }
};
