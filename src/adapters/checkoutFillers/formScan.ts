import type { Frame, Locator, Page } from "playwright-core";
import { parseUsdCents, type CardDetails } from "./CheckoutFiller.js";
import { digits, pad2 } from "./PlaywrightFiller.js";

/**
 * Reading an unfamiliar checkout page: every visible form control in every frame, described by its own attributes and
 * label (never its value), so a rule or a model can tell which field wants what. Each control is tagged in the page with
 * data-agentcards-ref so it can be found again. Used by AdaptiveFiller.
 */

/** What a field wants. Card kinds are the ones that may only ever go into a card-shaped input. */
export type FieldKind =
  | "card_number" | "card_expiry" | "card_exp_month" | "card_exp_year" | "card_cvc"
  | "cardholder_name" | "email" | "billing_postal_code" | "billing_address_line1" | "billing_city" | "billing_state" | "billing_country";

export const FIELD_KINDS: readonly FieldKind[] = [
  "card_number", "card_expiry", "card_exp_month", "card_exp_year", "card_cvc",
  "cardholder_name", "email", "billing_postal_code", "billing_address_line1", "billing_city", "billing_state", "billing_country",
];
export const CARD_KINDS: ReadonlySet<FieldKind> = new Set(["card_number", "card_expiry", "card_exp_month", "card_exp_year", "card_cvc"]);

/** A control as the page describes it. Sent to the planning model as is: attributes and labels only, no values. */
export interface FieldInfo {
  /** "<frame>.<n>", e.g. "0.3" (frame 0 is the page itself). */
  ref: string;
  /** Host of the frame the control is in. */
  frameHost: string;
  tag: string;
  type: string;
  name: string;
  id: string;
  autocomplete: string;
  placeholder: string;
  ariaLabel: string;
  label: string;
  /** Visible text of a button or link. */
  text: string;
  maxLength: number | null;
  required: boolean;
  disabled: boolean;
  /** Index of the enclosing <form> in its frame, -1 when none. */
  form: number;
  /** For a <select>: up to 60 options (value and text). */
  options?: { value: string; text: string }[];
}

export interface ScannedField extends FieldInfo {
  frame: Frame;
}

const REF_ATTR = "data-agentcards-ref";

/** Every visible control in every frame. Re-scan after anything that may re-render the page. */
export async function scanFields(page: Page): Promise<ScannedField[]> {
  const out: ScannedField[] = [];
  const frames = page.frames();
  for (let fi = 0; fi < frames.length; fi++) {
    const frame = frames[fi]!;
    let host = "";
    try {
      host = new URL(frame.url()).host;
    } catch {
      continue;
    }
    const arg = JSON.stringify({ attr: REF_ATTR, prefix: `${fi}.` });
    const found = await frame.evaluate<FieldInfo[]>(`(${SCAN_IN_PAGE})(${arg})`).catch(() => [] as FieldInfo[]);
    for (const f of found) out.push({ ...f, frameHost: host, frame });
  }
  return out;
}

/**
 * Runs inside a frame. Kept as plain JavaScript source: a compiled function can carry build helpers (esbuild's __name)
 * that do not exist in the page.
 */
const SCAN_IN_PAGE = String.raw`(arg) => {
  const clip = (s, n = 80) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && s.visibility !== "hidden" && s.display !== "none";
  };
  const labelOf = (el) => {
    if (el.labels && el.labels.length) return clip(el.labels[0].innerText);
    const by = el.getAttribute("aria-labelledby");
    if (by) return clip(by.split(/\s+/).map((id) => (document.getElementById(id) || {}).innerText || "").join(" "));
    const wrap = el.closest("label");
    if (wrap) return clip(wrap.innerText);
    const prev = el.previousElementSibling;
    if (prev && prev.innerText) return clip(prev.innerText);
    const kids = el.parentElement ? Array.from(el.parentElement.childNodes) : [];
    return clip(kids.filter((k) => k.nodeType === 3).map((k) => k.textContent).join(" "));
  };
  const forms = Array.from(document.forms);
  const res = [];
  let n = 0;
  for (const el of Array.from(document.querySelectorAll("input, select, textarea, button, [role=button], a[href]"))) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "input" && type === "hidden") continue;
    // Checkboxes and radios are often visually replaced by a styled sibling: keep them when their label shows.
    const box = tag === "input" && (type === "checkbox" || type === "radio");
    const wrapLabel = el.closest("label");
    if (!shown(el) && !(box && wrapLabel && shown(wrapLabel))) continue;
    if (tag === "a" && !/pay|order|purchase|checkout|continue|next|confirm|buy/i.test(el.innerText)) continue;
    const ref = arg.prefix + n++;
    el.setAttribute(arg.attr, ref);
    const isButton = tag === "button" || tag === "a" || el.getAttribute("role") === "button" || (tag === "input" && /^(submit|button)$/.test(type));
    const ml = el.maxLength;
    const formEl = el.form || el.closest("form");
    const info = {
      ref, frameHost: "", tag, type,
      name: clip(el.getAttribute("name")), id: clip(el.id), autocomplete: clip(el.getAttribute("autocomplete")),
      placeholder: clip(el.getAttribute("placeholder")), ariaLabel: clip(el.getAttribute("aria-label")),
      label: isButton ? "" : labelOf(el),
      // A button's own wording ("Pay $5.00"); an input button's value is its label, not user data. Field values are never read.
      text: isButton ? clip(tag === "input" ? el.value : el.innerText, 60) : "",
      maxLength: typeof ml === "number" && ml > 0 ? ml : null,
      required: el.required === true || el.getAttribute("aria-required") === "true",
      disabled: el.disabled === true,
      form: formEl ? forms.indexOf(formEl) : -1,
    };
    if (tag === "select") info.options = Array.from(el.options).slice(0, 60).map((o) => ({ value: clip(o.value, 40), text: clip(o.text, 40) }));
    res.push(info);
  }
  return res;
}`;

export const locate = (f: ScannedField): Locator => f.frame.locator(`[${REF_ATTR}="${f.ref}"]`).first();

export const isButtonLike = (f: FieldInfo) =>
  f.tag === "button" || f.tag === "a" || (f.tag === "input" && (f.type === "submit" || f.type === "button")) || (f.tag !== "input" && f.tag !== "select" && f.tag !== "textarea");

/** A text-entry input (where a card number, expiry or CVC can go). */
export const isTextInput = (f: FieldInfo) => f.tag === "input" && ["", "text", "tel", "number", "password"].includes(f.type);

// ---------- recognising fields by their labels (the "generic" route) ----------

const AUTOCOMPLETE: Record<string, FieldKind> = {
  "cc-number": "card_number", "cc-exp": "card_expiry", "cc-exp-month": "card_exp_month", "cc-exp-year": "card_exp_year", "cc-csc": "card_cvc",
  "cc-name": "cardholder_name", email: "email", "postal-code": "billing_postal_code", "address-line1": "billing_address_line1",
  "street-address": "billing_address_line1", "address-level2": "billing_city", "address-level1": "billing_state", country: "billing_country", "country-name": "billing_country",
};

/** Tried in order: the CVC before the number ("card code"), month and year before a combined expiry. */
const PATTERNS: [FieldKind, RegExp][] = [
  ["card_cvc", /\b(cvc|cvv|cvn|csc|cv2|cvc2)\b|security.?code|card.?code|verification.?(code|number)/],
  ["card_number", /card.?(number|no\b|num)|cc.?num|cardnumber|credit.?card|debit.?card|\bpan\b/],
  ["card_exp_month", /exp\w*.{0,8}(month|\bmm\b)|^mm$|^month$/],
  ["card_exp_year", /exp\w*.{0,8}(year|\byy)|^yy(yy)?$|^year$/],
  ["card_expiry", /expir|\bexp\b|\bexp.?date|mm\s*\/\s*yy|valid.?(thru|through|until)/],
  ["cardholder_name", /name.?on.?card|card.?holder|holder.?name|cc.?name|name.?as.?(it.?)?appears/],
  ["email", /e-?mail/],
  ["billing_postal_code", /\bzip\b|zip.?code|postal|post.?code/],
  ["billing_address_line1", /address.?(line)?.?1\b|street|billing.?address|^address$/],
  ["billing_city", /\bcity\b|\btown\b|locality/],
  ["billing_state", /\bstate\b|province|region/],
  ["billing_country", /country/],
];

/** What a field wants, from its autocomplete token, else its name, id, placeholder and label. Undefined when unsure. */
export function classify(f: FieldInfo): FieldKind | undefined {
  if (f.tag !== "input" && f.tag !== "select") return undefined;
  if (f.tag === "input" && !["", "text", "tel", "number", "password", "email"].includes(f.type)) return undefined;
  const ac = f.autocomplete.toLowerCase().split(/\s+/).find((t) => t in AUTOCOMPLETE);
  if (ac) return AUTOCOMPLETE[ac];
  if (f.type === "email") return "email";
  for (const text of [f.name, f.id, f.placeholder, f.ariaLabel, f.label].map((s) => s.toLowerCase().replace(/[_-]+/g, " ").trim())) {
    if (!text) continue;
    for (const [kind, re] of PATTERNS) if (re.test(text)) return kind;
  }
  return undefined;
}

const PAY_WORDS = /^(pay\b|place (my )?order|complete (my )?(order|purchase|payment)|buy now|confirm (and|&) pay|submit (payment|order)|purchase\b|pay now)/i;
export const looksLikePay = (f: FieldInfo) => isButtonLike(f) && PAY_WORDS.test(f.text.trim());

/** What to type for a kind, given the card and the field (a select gets the option to pick). */
export function valueFor(kind: FieldKind, f: FieldInfo, card: CardDetails, email: string): { type: string; keys?: string } | { select: string[] } | undefined {
  const mm = pad2(card.expMonth);
  const yyyy = String(card.expYear);
  const yy = yyyy.slice(-2);
  const addr = card.billingAddress;
  const longYear = /yyyy/i.test(`${f.placeholder} ${f.label}`) || f.maxLength === 4 || f.maxLength === 7 || f.maxLength === 9;
  switch (kind) {
    case "card_number": return { type: digits(card.pan) };
    case "card_cvc": return { type: digits(card.cvv) };
    case "card_expiry": return longYear ? { type: `${mm}/${yyyy}`, keys: `${mm}${yyyy}` } : { type: `${mm}/${yy}`, keys: `${mm}${yy}` };
    case "card_exp_month":
      if (f.tag === "select") return { select: [mm, String(card.expMonth), MONTHS[card.expMonth - 1]!, MONTHS[card.expMonth - 1]!.slice(0, 3)] };
      return { type: mm };
    case "card_exp_year":
      if (f.tag === "select") return { select: [yyyy, yy] };
      return { type: f.maxLength === 2 ? yy : yyyy };
    case "cardholder_name": return { type: card.nameOnCard?.trim() || "Card Holder" };
    case "email": return { type: email };
    case "billing_postal_code": return card.billingZip ? { type: card.billingZip } : undefined;
    case "billing_address_line1": return addr?.line1 ? { type: addr.line1 } : undefined;
    case "billing_city": return addr?.city ? { type: addr.city } : undefined;
    case "billing_state": return addr?.state ? (f.tag === "select" ? { select: [addr.state] } : { type: addr.state }) : undefined;
    case "billing_country": {
      const c = addr?.country || "US";
      return f.tag === "select" ? { select: c === "US" ? ["US", "USA", "United States", "United States of America"] : [c] } : { type: c };
    }
  }
}
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// ---------- reading the price ----------

const TOTAL_LINE = /\b(total|amount due|due today|you pay|to pay|order total|grand total|charge)\b/i;
const NOT_TOTAL = /sub-?total|saving|discount|\btax\b|shipping/i;

/**
 * The page's total, read from its text before any card data is typed: amounts on lines labelled total (or on the line
 * after such a label), and on the pay button. Empty when nothing is readable.
 */
export async function readTotals(page: Page): Promise<number[]> {
  const totals: number[] = [];
  for (const frame of page.frames()) {
    const text = await frame.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      if (/^pay\b/i.test(l)) {
        const c = parseUsdCents(l);
        if (c !== undefined) totals.push(c);
        continue;
      }
      if (!TOTAL_LINE.test(l) || NOT_TOTAL.test(l)) continue;
      const c = parseUsdCents(l) ?? (lines[i + 1] && !TOTAL_LINE.test(lines[i + 1]!) ? parseUsdCents(lines[i + 1]!) : undefined);
      if (c !== undefined) totals.push(c);
    }
  }
  return totals;
}

/** Matches when the agreed price is shown as a total and nothing labelled total is higher. */
export function totalsMatch(totals: number[], expected: number): { ok: true } | { ok: false; shown?: number } {
  if (totals.length === 0) return { ok: false };
  if (totals.includes(expected) && totals.every((t) => t <= expected)) return { ok: true };
  return { ok: false, shown: totals.find((t) => t !== expected) ?? totals[0] };
}

// ---------- hosts a server-side browser must never be pointed at ----------

/**
 * True for hosts that are, or are named as, this machine or a private network: localhost, single-label names, .local,
 * .internal, and private, loopback, link-local and CGNAT IP literals. A DNS name that resolves to a private address is
 * not caught here (the browser's request guard is a second line).
 */
export function isPrivateHost(hostWithPort: string): boolean {
  let host = hostWithPort.toLowerCase();
  if (host.startsWith("[")) host = host.slice(1, host.indexOf("]"));
  else host = host.replace(/:\d+$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan") || host.endsWith(".home.arpa")) return true;
  if (!host.includes(".") && !host.includes(":")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  // Any other all-numeric form (decimal, hex, octal IPv4 spellings) is refused outright.
  if (/^[\d.]+$/.test(host) || /^0x/i.test(host)) return true;
  if (host.includes(":")) return host === "::" || host === "::1" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith("::ffff:");
  return false;
}
