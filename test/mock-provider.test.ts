import { test } from "node:test";
import assert from "node:assert/strict";
import { MockCardProvider } from "../src/adapters/providers/mock/MockCardProvider.js";
import { CardProviderBusinessError, isDefiniteRefusal } from "../src/domain/errors/CardProviderErrors.js";
import { MemoryCardVault } from "../src/adapters/cardVault/CardVault.js";
import type { IndividualKyc } from "../src/domain/interfaces/CardIssuing.js";

const kyc: IndividualKyc = {
  firstName: "T", lastName: "P", dateOfBirth: "1990-01-01", idType: "PASSPORT", idNumber: "A1", idFrontImage: "data:image/png;base64,AA",
  phone: "+10000000000", email: "t@example.com", address: { address1: "1 St", city: "X", state: "Y", zipcode: "1", country: "US" },
};
const policy = { perTransactionCents: 5_000, dailyCents: 10_000 };
const holder = { customerId: "c", kycToken: "k" };

test("mock: KYC is approved at once and reads back a customer", async () => {
  const m = new MockCardProvider();
  assert.deepEqual(await m.submitKyc("kyc-u1", kyc), { kycStatus: "Approved" });
  const s = await m.kycStatus("kyc-u1");
  assert.equal(s.status, "Approved");
  assert.ok(s.customerId && s.kycToken);
});

test("mock: issue is stable per reference, top-up is idempotent, balance and transactions agree", async () => {
  const m = new MockCardProvider();
  const a = await m.issue("agent", policy, holder, "ref1", 5);
  assert.equal((await m.issue("agent", policy, holder, "ref1", 5)).id, a.id);
  const r1 = await m.topUp(a, 2_500, "USDC", "fund-1");
  const r2 = await m.topUp(a, 2_500, "USDC", "fund-1");
  assert.equal(r1.id, r2.id);
  assert.equal(await m.cardBalance(a.id), 30); // $5 at issue + one $25 top-up (the replay did not add again)
  const fundings = await m.transactions(a.id, "CardFunding");
  assert.equal(fundings.length, 1);
  assert.equal(fundings[0]!.transactionReference, "fund-1");
});

test("mock: a simulated purchase charges once per key; an overdraw is a definite refusal and is recorded", async () => {
  const m = new MockCardProvider();
  const a = await m.issue("agent", policy, holder, "ref2", 10);
  const id1 = await m.simulateAuthorization({ cardId: a.id, amountDollars: 4, mid: "m1" }, { idempotencyKey: "auth:1" });
  const id2 = await m.simulateAuthorization({ cardId: a.id, amountDollars: 4, mid: "m1" }, { idempotencyKey: "auth:1" });
  assert.equal(id1, id2);
  assert.equal(await m.cardBalance(a.id), 6);
  const err = await m.simulateAuthorization({ cardId: a.id, amountDollars: 50, mid: "m2" }).catch((e) => e);
  assert.ok(err instanceof CardProviderBusinessError);
  assert.equal(isDefiniteRefusal(err), true);
  const auths = await m.transactions(a.id, "Authorization");
  assert.equal(auths.find((t) => t.merchantMid === "m2")?.transactionStatus, "Declined");
});

test("mock: one-time cards honour the $1 minimum and are vaulted only on request", async () => {
  const vault = new MemoryCardVault();
  const m = new MockCardProvider({ vault });
  const a = await m.issueOneTime(holder, 50, "p1", { capture: true });
  assert.equal(a.detailsCaptured, true);
  assert.equal(await vault.has(a.cardId), true);
  assert.equal(await m.cardBalance(a.cardId), 1);
  const b = await m.issueOneTime(holder, 500, "p2", { capture: false });
  assert.equal(b.detailsCaptured, false);
  assert.equal(await vault.has(b.cardId), false);
});

test("mock: authorize enforces the policy and the daily total", () => {
  const m = new MockCardProvider();
  const card = { id: "c", agentId: "a", policy };
  assert.deepEqual(m.authorize(card, 5_000), { ok: true });
  assert.deepEqual(m.authorize(card, 5_000), { ok: true });
  assert.equal(m.authorize(card, 100).ok, false);
});
