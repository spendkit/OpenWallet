# Checkout swap: agents paying hosted checkouts

An agent pays a third-party hosted checkout page (Stripe Checkout `checkout.stripe.com/c/pay/...`, or a Payment Link `buy.stripe.com/...`). The agent sends the URL and the exact price it agreed to. Our server opens the page and puts in the owner's real card, which it reads from the vault. The agent never sees the card.

```
agent ── pay_hosted_checkout(url, amount, merchant, key) ──► SwapInteractor
  1. validate: swap on, host allowlisted (https), amount ≤ cap ($10), key present, card in vault
  2. CardholderInteractor.pay under spend key checkout:swap:<swapId>: agent limits, balance, ledger debit
  3. charge (one at a time per process):
       vault.reveal(card, "checkout:<swapId>")   ← audited, after the debit, just before the page
       PlaywrightFiller: load → bot check? → read the total, must equal amount → type card → pay → watch
       scrub(details) in a finally
  4. outcome → spend: succeeded = approved · declined / not submitted = voided (debit undone)
                       submitted, no clear answer (3DS, captcha after submit, timeout) = processing (money held)
  5. reconcile (every 5 s tick, after 60 s): match the card's Miden Authorization by amount + time, unclaimed
       one approved → paid · declined → voided · several → needs_review · none after 30 min → needs_review
     and for pages that said "paid": confirm on the card and record the real MCC; mismatch or nothing → review
```

Code: `src/lib/interactors/SwapInteractor.ts` (the use case) and `src/adapters/checkoutFillers/` (`PlaywrightFiller.ts`, `CheckoutFiller.ts` types and scrub, `fixtures/stripeFixture.ts` local Stripe-like page), migration `009_checkout_swap.sql`. The vault and card capture are Kai's: `src/adapters/cardVault/CardVault.ts`, `src/adapters/virtualCards/CardService.ts`.

## Statuses

| status | meaning | money |
| --- | --- | --- |
| `paid` | page confirmed (and later the card, see `underReview`) | debited |
| `failed` | declined, price mismatch, unsupported page, limits | returned |
| `challenge` | captcha or 3-D Secure. Never retried automatically. A new attempt needs a new key. | returned if stopped before submit, held if after |
| `processing` | submitted, answer unknown | held until reconcile |
| `needs_review` | ambiguous or silent card. A person decides. | held |

A failed attempt (declined, mismatch, unsupported page, limits, or a challenge stopped before submit) costs nothing: the debit is undone.

Rules kept from the device side: a challenge is its own failure state; the reveal happens as late as possible; nothing from the page is captured once the card is typed (no DOM, no screenshot, decline text matched but not stored); error text is stripped of card values.

## Config (env)

| var | default | |
| --- | --- | --- |
| `SWAP_ENABLED` | off | `1` turns it on. Needs `CARD_VAULT_KEY`. |
| `SWAP_MAX_CENTS` | `1000` | hard cap per swap |
| `SWAP_ALLOWED_HOSTS` | `checkout.stripe.com,buy.stripe.com` | exact https hosts |
| `SWAP_INSECURE_HOSTS` | none | http hosts, for the local fixture only |
| `SWAP_RECEIPT_EMAIL` | owner's email | fallback receipt email |
| `SWAP_STRIPE_TEST_CARD` | off | sandbox only: `1` pays Stripe **test-mode** links (`cs_test_...`, `buy.stripe.com/test_...`) with Stripe's 4242 test card instead of the vault. The vault is not opened, no card authorization is expected afterwards, and live links are unaffected. Refused at startup off the Miden sandbox. The agent's balance is still debited in our ledger although no card is charged, so in this mode a ledger debit is not proof of a card spend. A swap left unclear is never matched to a card authorization; after 30 minutes it goes to a person. Used by `examples/n8n/agent-pays-stripe-link.workflow.json`. |
| `SWAP_TEST_HOSTS` | none | sandbox only, needs `SWAP_STRIPE_TEST_CARD=1`: exact hosts (http or https) of test shops whose checkouts are paid with the same 4242 test card and can be watched live. |
| `SWAP_OPEN_HOSTS` | off | `1`: a public https checkout on a host that is **not** in `SWAP_ALLOWED_HOSTS` may be paid too, but only ever with a one-time card holding exactly the agreed amount (made for that payment, privacy mode or not). Hosts naming this machine or a private network (localhost, `.local`, `.internal`, private and link-local IPs) are refused. See "Unfamiliar checkouts". |
| `SWAP_AI_FILL` | on when `ANTHROPIC_API_KEY` is set | `0` turns the model off: unfamiliar forms are then paid only when their labels are clear. |
| `SWAP_AI_MODEL` | `claude-opus-5-5` | the model that maps unfamiliar forms. |

Agent surfaces: MCP `pay_hosted_checkout` / `get_hosted_checkout_payment`; REST `POST /agent/v1/hosted-checkouts/pay`, `GET /agent/v1/hosted-checkouts[/sw_...]`.

Matching: on a real checkout the card's `merchantMid` belongs to the merchant's acquirer and is the same for every payment to that merchant, and `transactionReference` is only known afterwards. That leaves amount + time as the only way to match (on the Miden sandbox mock path, `midFor(spendId)` makes `merchantMid` unique per spend, so it matches by MID instead). Two guards:

- **Busy**: while one swap of a given amount on a card is still unsettled (pending, filling, processing, a held challenge, or paid on the page but not yet seen on the card), a new swap of the same amount on that card gets a 409 saying "try again in a minute". Nothing is reserved. A retry under the same idempotency key is never refused.
- **Backstop**: if two unsettled swaps could still own one authorization (for example, one is left in `needs_review`), neither claims it. Both go to review and the money stays held.

Known limit: an agent paying the same amount twice in quick succession on one card waits for the first payment to show on the card, about a minute.

MCC: on a swap the agent declares the merchant category, and nothing verifies it at payment time. The real fence is the card's `whiteListedMccs`, set at issue (network enforcement is unconfirmed). Reconcile compares the declared MCC with `merchantMcc` on the card's Authorization and flags any mismatch.

## Proving it without real money

The live $10 test is parked: no live payments for now. It is covered in two halves instead:

1. **Card side, Miden sandbox**: `tsx scripts/swap-sandbox-e2e.ts --card <sandbox cardId> --amount 1.00`. A real sandbox card's details go through the vault and real Chromium onto the fixture page. Pressing pay fires Miden's mock authorization, and the script matches it on the card's transactions.
2. **Page side, Stripe test mode**: `tsx scripts/swap-rehearsal.ts --url <Stripe TEST Checkout or Payment Link> --amount <exact total>` pays with Stripe's 4242 test card. It refuses non-test URLs. With no `--url` it runs every fixture scenario.
3. **Logic**: `test/checkout-swap.test.ts` covers the filler on the fixture and the service against Postgres: idempotency, cap, limits, scrub, audit, challenge, reconcile, MCC review, and same-amount busy/rival handling.

Result of step 2 against a real Stripe test-mode Checkout ($1.00, 2026-10-19): **passed**, and Stripe's API confirmed the session `complete / paid`. Getting there needed four fixes to the filler, and each one is now mirrored in the fixture:

- The page is client-rendered, and the total's container appears before its text. The filler now polls for a readable total, and reloads once (before anything is typed) if the page never renders. That happens intermittently in headless Chromium.
- Every Stripe page loads an invisible hCaptcha in a hidden 1px frame. Only a captcha frame that is actually visible counts as a bot check.
- The card accordion button is 0x0 and takes clicks through a pseudo-element, so the filler clicks the row.
- The pay button goes `--clickable` → `--complete` (form complete, ready) → `--processing` → `--success` → redirect. `--complete` is **not** paid: treating it as paid gave a false "succeeded" on an unpaid session. The filler waits for ready before pressing, and counts only `--success` or the redirect as paid.

Sessions with tax on (Managed Payments) or `billing_address_collection=required` demand a full street address. `CardDetails.billingAddress` holds it. Without one on file, the filler stops **before** pressing pay (`unsupported_page`, nothing charged). The address comes from Miden's full-PAN `billingDetails` (the KYC address submitted at onboarding), mapped by `toBillingAddress()` only when line 1, city and country are all set. Country is alpha-2 (`NG`); state is a name (`Lagos`), so a state dropdown is matched on value or label. The filler also stops before paying if the page cannot select the card's country or has no matching state option, so it never types one country's address into another country's form. Already-vaulted cards pick up the address with `scripts/card-capture-check.ts --capture <id> --persist --refresh`.

Rehearse the address path with `tsx scripts/swap-rehearsal.ts --url <cs_test url> --amount 10.00 --miden-address` (a synthetic Lagos address on the 4242 test card). Passed on 2026-10-19: Stripe recorded the session as paid with the full NG address. Test sessions created through the API on this account need `managed_payments[enabled]=false` unless the product has a tax code.

What these cannot prove: a real card accepted on a live Stripe page, a real issuer's 3DS behaviour, our live Stripe account's MCC. `scripts/swap-live-test.ts` stays ready for that. It runs a preflight checklist, refuses anything over $10, needs `--confirm-live`, keeps a journal per URL so it can never pay twice, and writes its report to `.live-test/`.

## Shopify checkouts

`ShopifyFiller` (`shopify-filler.ts`) pays `https://<shop>/checkouts/...` pages; `RoutingFiller` picks it (or the Stripe filler) from the URL. Each shop's host must be added to `SWAP_ALLOWED_HOSTS` (for example `yourshop.myshopify.com`); there is no `*.myshopify.com` wildcard, because anyone can open a Shopify store.

It checks the total at load, again after the contact/shipping steps (shipping and tax change it), and once more just before pressing pay; the card is typed only after the second check. A total not in USD, a missing delivery address, or an unmatched country/state stops the run before the card is typed. Card fields live in separate iframes and are typed key by key.

**Tested** against a local mock (`shopify-fixture.ts`, `test/shopify-filler.test.ts`, 9 tests passing): logic, price checks, multi-step flow, outcome classification, Bogus Gateway rules (card `1` pays, `2` declines, `3` raises).

**Not tested**: that Shopify's real markup matches our selectors (input names, card-frame titles, `#checkout-pay-button`, total markup are from published knowledge, not a live page), Shopify's bot checks, real 3-D Secure.

**To test on a real page for free**: create a Shopify development store (free Partner account), enable the Bogus Gateway under Payments, open a checkout, and run the filler with a card whose number is `1`.

## Lemon Squeezy checkouts

`LemonSqueezyFiller` (`lemonsqueezy-filler.ts`) pays `https://<store>.lemonsqueezy.com/checkout/...` pages; `RoutingFiller` picks it by host + path. Add each store's host to `SWAP_ALLOWED_HOSTS`; there is no wildcard.

Lemon Squeezy is the merchant of record, so **tax is added once the billing country and ZIP are entered**. The filler checks the total at load, again after country + ZIP, and once more before pressing pay; the card is typed only after the second check. It refuses (nothing typed) a non-USD total, a country the page does not offer, or a card with no ZIP on file. Card fields are Stripe Elements iframes (one frame per field, or one frame for all three); the filler finds each by the input inside it.

**Tested** against a local mock (`lemonsqueezy-fixture.ts`, `test/lemonsqueezy-filler.test.ts`): routing, both frame layouts, the tax price change, outcome classification.

**Not tested**: that Lemon Squeezy's real markup matches our selectors (total element, field names, pay button, confirmation) — they are from general knowledge, not a live page. Also bot checks and real 3-D Secure. **To test for free**: create a Lemon Squeezy store in test mode, make a product, open its test checkout URL and pay with `4242 4242 4242 4242`; expect to adjust selectors in `SEL`.

## Paddle checkouts

`PaddleFiller` (`paddle-filler.ts`) pays Paddle Billing checkouts: hosted links (`pay.paddle.io/hsc_...`, `sandbox-pay.paddle.io`), `*.paddle.com` pages, and any merchant page carrying `?_ptxn=txn_...` (Paddle's checkout opens in an iframe there; the filler works out whether the form is the page or a frame). `RoutingFiller` picks it from the URL. Add the exact host to `SWAP_ALLOWED_HOSTS` (for example `pay.paddle.io`); a `_ptxn` link is on the merchant's own host, which must be allowed too.

Paddle is the merchant of record, so tax is added from the buyer's country and postal code. That changes the price check:

- **At load**: a total above the agreed amount is refused; a lower, pre-tax total passes.
- **After country + postal code** (taken from the card's billing address and ZIP): the total must equal the agreed amount exactly, and only then is the card typed. Agree the tax-inclusive amount.
- **Before pressing pay**: checked again.

Without a billing country and postal code on file, or if the form has no option for the card's country, the run stops before anything is typed (`unsupported_page`, nothing charged). A total not in USD is refused. Success is Paddle's success state or a redirect to a `/thank-you`, `/success`, `/confirmation` or `/done` page; a decline message is matched by wording only and not stored; no answer after pressing pay is `error` with `submitted: true` (charge state unknown).

**Tested** against a local mock (`paddle-fixture.ts`, `test/paddle-filler.test.ts`): hosted and iframe layouts, the tax step, price checks, missing billing details, outcome classification.

**Not tested**: that Paddle's real markup matches our selectors (field names and labels, button names, `data-testid` total markup are from published knowledge, not a live page), Paddle's bot checks, real 3-D Secure, and the tax behaviour of a real account.

**To test on a real page for free**: use a Paddle sandbox account, create a transaction and open its checkout, then run the filler with the sandbox test card `4242 4242 4242 4242` and the exact tax-inclusive total.

## Unfamiliar checkouts

`AdaptiveFiller` (`AdaptiveFiller.ts`, `formScan.ts`, `FormPlanner.ts`) pays checkout pages none of the fillers above was written for. `RoutingFiller` sends it every page it has no filler for, but only when `SWAP_OPEN_HOSTS=1` or `SWAP_TEST_HOSTS` is set; otherwise such pages are refused before a browser opens, as before.

1. The price comes first: an amount on a line labelled total (or the line after the label, or the pay button) must equal the agreed price, and nothing labelled total may be higher. If it doesn't match, nothing is typed. It is checked again after each "continue" and on the page that takes the card.
2. **Labels:** each field's autocomplete token, then its name, id, placeholder and label (`cc-number`, "Card number", "CVC"...). A card number, a CVC, an expiry and exactly one pay button are needed, plus nothing required that we cannot fill. No model is involved.
3. **Model** (only when the labels are not enough, and `ANTHROPIC_API_KEY` is set): `ClaudeFormPlanner` gets the controls (attributes and labels, never values) and a screenshot taken before any card data is typed. For each field it answers with a stand-in (`card_number`, `email`...), never a value. It can name a continue button for multi-step checkouts (at most 3 steps), or refuse the page (`cannotPay`: login, one-time code, odd price). The page counts as untrusted input. `checkPlan` rejects a plan that puts card data anywhere except a text input (or an expiry select), into a field the page labels as something else, outside the pay button's form, or into more than one field. It never ticks newsletter, save-card, subscription or add-on boxes.
4. After the card is typed, nothing from the page is kept or sent: the result comes from the URL, frames and fixed wording (success, decline, 3-D Secure, captcha). No answer means unknown, so the money stays held, as for the other fillers.
5. The browser context blocks requests to private hosts other than the start host.

What this does not catch: a page that labels a card-shaped field innocently (for example "Reference") and steers the model to put the card number there. That is why an open host is paid only with a one-time card holding exactly the agreed amount: the worst case is that amount, once.
