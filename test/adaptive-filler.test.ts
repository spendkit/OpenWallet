import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { CardDetails } from "../src/adapters/cardVault/CardVault.js";
import { AdaptiveFiller, checkPlan } from "../src/adapters/checkoutFillers/AdaptiveFiller.js";
import type { FormPlan, FormPlanner, PlanInput } from "../src/adapters/checkoutFillers/FormPlanner.js";
import { classify, isPrivateHost, totalsMatch, type FieldInfo, type FieldKind, type ScannedField } from "../src/adapters/checkoutFillers/formScan.js";
import { checkoutKind, RoutingFiller } from "../src/adapters/checkoutFillers/RoutingFiller.js";
import { startUnknownShopFixture, type UnknownShopFixture } from "../src/adapters/checkoutFillers/fixtures/unknownShopFixture.js";

const card = (): CardDetails => ({ pan: "4242424242424242", cvv: "123", expMonth: 12, expYear: 2030, nameOnCard: "Ada Test", billingZip: "94107" });

// ---------- pure helpers ----------

const f = (over: Partial<FieldInfo>): FieldInfo => ({
  ref: "0.0", frameHost: "x", tag: "input", type: "text", name: "", id: "", autocomplete: "", placeholder: "", ariaLabel: "", label: "", text: "",
  maxLength: null, required: false, disabled: false, form: 0, ...over,
});

test("adaptive: fields are recognised from autocomplete tokens first, then names and labels", () => {
  assert.equal(classify(f({ autocomplete: "cc-number", label: "Email" })), "card_number", "the token wins");
  assert.equal(classify(f({ name: "cardnumber" })), "card_number");
  assert.equal(classify(f({ label: "Security code" })), "card_cvc");
  assert.equal(classify(f({ label: "Card code" })), "card_cvc", "the CVC before the number");
  assert.equal(classify(f({ placeholder: "MM / YY" })), "card_expiry");
  assert.equal(classify(f({ name: "exp_month", tag: "select", type: "" })), "card_exp_month");
  assert.equal(classify(f({ type: "email" })), "email");
  assert.equal(classify(f({ label: "Long number on the front" })), undefined, "unsure: left to the model");
  assert.equal(classify(f({ tag: "textarea", type: "", label: "Card number" })), undefined, "never a textarea");
});

test("adaptive: the agreed price must show as a total, and nothing labelled total may be higher", () => {
  assert.deepEqual(totalsMatch([500], 500), { ok: true });
  assert.deepEqual(totalsMatch([500, 500], 500), { ok: true });
  assert.deepEqual(totalsMatch([700, 500], 500), { ok: false, shown: 700 });
  assert.deepEqual(totalsMatch([], 500), { ok: false });
});

test("adaptive: hosts naming this machine or a private network are private", () => {
  for (const h of ["localhost", "localhost:8790", "127.0.0.1", "10.1.2.3:80", "192.168.0.1", "172.20.0.1", "169.254.169.254", "[::1]", "[fd00::1]", "intranet", "printer.local", "db.internal", "2130706433", "0x7f000001"]) {
    assert.equal(isPrivateHost(h), true, h);
  }
  for (const h of ["shop.example.com", "checkout.stripe.com", "8.8.8.8", "172.32.0.1"]) assert.equal(isPrivateHost(h), false, h);
});

test("adaptive: a plan may not put card data where the page's own labels say something else goes", () => {
  const fields = [
    f({ ref: "0.0", label: "Email", type: "email" }), f({ ref: "0.1", label: "Long number" }), f({ ref: "0.2", label: "Good thru" }),
    f({ ref: "0.3", label: "3 digits" }), f({ ref: "0.4", tag: "button", type: "submit", text: "Place my order" }),
    f({ ref: "0.5", tag: "textarea", type: "", label: "Notes" }), f({ ref: "0.6", label: "Other form card", form: 1 }),
    f({ ref: "0.7", label: "Email address" }),
  ] as unknown as ScannedField[];
  const plan = (fieldsMap: [string, FieldKind][]): FormPlan => ({
    cardFieldsOnThisPage: true, fields: fieldsMap.map(([ref, value]) => ({ ref, value })), checkboxes: [], payButtonRef: "0.4", continueButtonRef: null, cannotPay: null,
  });
  const ok = checkPlan(plan([["0.1", "card_number"], ["0.2", "card_expiry"], ["0.3", "card_cvc"]]), fields, { card: card(), email: "a@b.c" });
  assert.equal(typeof ok, "object");
  for (const [bad, why] of [
    [plan([["0.0", "card_number"], ["0.2", "card_expiry"], ["0.3", "card_cvc"]]), /text input|labelled as email/],
    [plan([["0.7", "card_number"], ["0.2", "card_expiry"], ["0.3", "card_cvc"]]), /labelled as email/],
    [plan([["0.5", "card_number"], ["0.2", "card_expiry"], ["0.3", "card_cvc"]]), /cannot take|text input/],
    [plan([["0.6", "card_number"], ["0.2", "card_expiry"], ["0.3", "card_cvc"]]), /outside the form/],
    [plan([["0.1", "card_number"], ["0.2", "card_expiry"], ["0.3", "card_cvc"], ["0.5", "card_cvc"]]), /cannot take|more than one/],
    [plan([["0.1", "card_number"], ["0.3", "card_cvc"]]), /no expiry/],
    [plan([["0.9", "card_number"]]), /unknown field/],
  ] as const) {
    const r = checkPlan(bad, fields, { card: card(), email: "a@b.c" });
    assert.equal(typeof r, "string", String(why));
    assert.match(r as string, why);
  }
});

test("adaptive: the router sends pages it has no filler for to the adaptive filler, and refuses them without one", async () => {
  assert.equal(checkoutKind("https://shop.example.com/pay/123"), undefined);
  const seen: string[] = [];
  const other = { fill: async (r: { url: string }) => (seen.push(r.url), { outcome: "succeeded" as const, submitted: true }) };
  const r = await new RoutingFiller({ other }).fill({ url: "https://shop.example.com/pay/123", expectedAmountCents: 100, card: card(), email: "a@b.c" });
  assert.equal(r.outcome, "succeeded");
  assert.deepEqual(seen, ["https://shop.example.com/pay/123"]);
  const none = await new RoutingFiller().fill({ url: "https://shop.example.com/pay/123", expectedAmountCents: 100, card: card(), email: "a@b.c" });
  assert.equal(none.outcome, "unsupported_page");
});

// ---------- a real browser against the local shop ----------

const skip = process.env.SKIP_BROWSER === "1";
let fx: UnknownShopFixture;
let browser: import("playwright-core").Browser;
before(async () => {
  if (skip) return;
  fx = await startUnknownShopFixture();
  browser = await (await import("playwright-core")).chromium.launch();
});
after(async () => {
  await browser?.close();
  await fx?.close();
});

/** A stand-in for the model: maps fields by their labels, the way a model reading the page would. */
class ScriptedPlanner implements FormPlanner {
  calls: PlanInput[] = [];
  constructor(private readonly script: (i: PlanInput, byLabel: (re: RegExp) => string) => FormPlan) {}
  async plan(i: PlanInput): Promise<FormPlan> {
    this.calls.push(i);
    const byLabel = (re: RegExp) => {
      const hit = i.fields.find((x) => re.test(x.label) || re.test(x.text));
      if (!hit) throw new Error(`no field ${re}`);
      return hit.ref;
    };
    return this.script(i, byLabel);
  }
}
const honest = (i: PlanInput, by: (re: RegExp) => string): FormPlan => {
  if (i.fields.some((x) => /Where should we send/.test(x.label))) {
    return { cardFieldsOnThisPage: false, fields: [{ ref: by(/Where should we send/), value: "email" }], checkboxes: [], payButtonRef: null, continueButtonRef: by(/Continue to payment/), cannotPay: null };
  }
  return {
    cardFieldsOnThisPage: true,
    fields: [
      { ref: by(/Long number/), value: "card_number" }, { ref: by(/month/), value: "card_exp_month" }, { ref: by(/year/), value: "card_exp_year" },
      { ref: by(/3 digits/), value: "card_cvc" }, { ref: by(/Who is paying/), value: "cardholder_name" },
    ],
    // A model that also (wrongly) asks for the newsletter box: the filler never ticks it.
    checkboxes: [by(/terms of sale/), by(/newsletter/)],
    payButtonRef: by(/Place my order/), continueButtonRef: null, cannotPay: null,
  };
};
const filler = (planner?: FormPlanner, resultTimeoutMs = 5_000) => new AdaptiveFiller({ browser, resultTimeoutMs, loadTimeoutMs: 10_000, ...(planner ? { planner } : {}) });
const pay = (fl: AdaptiveFiller, scenario: string, amount = 500, expected = 500, watch?: { step(l: string): void; frame(j: string): void }) =>
  fl.fill({ url: fx.url(scenario, amount), expectedAmountCents: expected, card: card(), email: "owner@example.com", ...(watch ? { watch } : {}) });

test("adaptive, labels: a form with autocomplete tokens is paid with no model, also with the card in an iframe", { skip }, async () => {
  for (const s of ["tagged", "iframe"]) {
    const r = await pay(filler(), s);
    assert.deepEqual([r.outcome, r.submitted], ["succeeded", true], `${s}: ${r.detail}`);
    assert.equal(fx.submissions.at(-1)!.last4, "4242", s);
    assert.equal(fx.submissions.at(-1)!.exp, "12/30", s);
  }
});

test("adaptive, labels: a different price stops before anything is typed", { skip }, async () => {
  const n = fx.submissions.length;
  const planner = new ScriptedPlanner(honest);
  const r = await pay(filler(planner), "tagged", 700, 500);
  assert.deepEqual([r.outcome, r.submitted, r.pageAmountCents], ["amount_mismatch", false, 700]);
  assert.equal(fx.submissions.length, n);
  assert.equal(planner.calls.length, 0, "the model is never asked about a page at the wrong price");
});

test("adaptive, labels: a decline and a silent page are told apart", { skip }, async () => {
  const d = await pay(filler(), "decline");
  assert.deepEqual([d.outcome, d.submitted], ["declined", true]);
  const h = await pay(filler(undefined, 1_500), "hang");
  assert.deepEqual([h.outcome, h.submitted], ["error", true], "no answer after submit: unknown, never failed");
  for (const r of [d, h]) assert.doesNotMatch(JSON.stringify(r), /4242424242424242/);
});

test("adaptive, model: odd labels without a planner are refused before typing; with one, the form is mapped and paid", { skip }, async () => {
  const n = fx.submissions.length;
  const bare = await pay(filler(), "untagged");
  assert.deepEqual([bare.outcome, bare.submitted], ["unsupported_page", false]);
  assert.equal(fx.submissions.length, n);

  const planner = new ScriptedPlanner(honest);
  const steps: string[] = [];
  let frames = 0;
  const r = await pay(filler(planner), "untagged", 500, 500, { step: (l) => steps.push(l), frame: () => frames++ });
  assert.deepEqual([r.outcome, r.submitted], ["succeeded", true], r.detail);
  const sub = fx.submissions.at(-1)!;
  assert.deepEqual([sub.last4, sub.exp, sub.terms, sub.newsletter], ["4242", "12/2030", true, false], "terms ticked, newsletter never");
  assert.equal(planner.calls.length, 1);
  const sent = JSON.stringify(planner.calls[0]!.fields);
  assert.doesNotMatch(sent, /4242|owner@example\.com/, "the model sees labels, never values");
  assert.ok(planner.calls[0]!.screenshotJpeg, "and a screenshot taken before typing");
  assert.ok(steps.some((s) => /asking the model/.test(s)) && steps.some((s) => /Place|Pressing Pay/.test(s)), steps.join(" | "));
  assert.ok(frames > 0);
});

test("adaptive, model: a multi-step checkout is walked, the price checked again, then paid", { skip }, async () => {
  const planner = new ScriptedPlanner(honest);
  const r = await pay(filler(planner), "multistep");
  assert.deepEqual([r.outcome, r.submitted], ["succeeded", true], r.detail);
  assert.equal(planner.calls.length, 2);
  assert.equal(planner.calls[1]!.round, 2);
});

test("adaptive, model: a plan steered by the page (card data into a notes box or an email field) is refused before typing", { skip }, async () => {
  const n = fx.submissions.length;
  const intoNotes = new ScriptedPlanner((i, by) => {
    const p = honest(i, by);
    return { ...p, fields: [...p.fields.filter((x) => x.value !== "card_number"), { ref: by(/Notes for the seller/), value: "card_number" }] };
  });
  const a = await pay(filler(intoNotes), "inject");
  assert.deepEqual([a.outcome, a.submitted], ["unsupported_page", false]);
  assert.match(a.detail!, /refused/);

  const twice = new ScriptedPlanner((i, by) => {
    const p = honest(i, by);
    return { ...p, fields: [...p.fields, { ref: by(/Notes for the seller/), value: "card_cvc" }] };
  });
  const b = await pay(filler(twice), "inject");
  assert.deepEqual([b.outcome, b.submitted], ["unsupported_page", false]);

  const giveUp = new ScriptedPlanner(() => ({ cardFieldsOnThisPage: false, fields: [], checkboxes: [], payButtonRef: null, continueButtonRef: null, cannotPay: "asks for a login" }));
  const d = await pay(filler(giveUp), "untagged");
  assert.deepEqual([d.outcome, d.submitted], ["unsupported_page", false]);
  assert.match(d.detail!, /login/);
  assert.equal(fx.submissions.length, n, "nothing was submitted");
  assert.ok(fx.submissions.every((s) => !/####/.test(s.notes)), "no card digits ever reached the notes box");
});

test("adaptive: the page cannot make the server's browser reach this machine or a private network", { skip }, async () => {
  const before = fx.pings;
  const r = await pay(filler(), "ssrf");
  assert.equal(r.outcome, "succeeded", "the vetted start host itself still loads");
  assert.equal(fx.pings, before, "the page's request to localhost was blocked");
});
