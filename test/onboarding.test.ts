import { test } from "node:test";
import assert from "node:assert/strict";
import { Onboarding, type IndividualKyc } from "../src/adapters/onboarding/onboarding.js";
import { CardService } from "../src/adapters/virtualCards/CardService.js";
import { TieredCardIssuer } from "../src/lib/services/tiers.js";
import { CardLifecycle } from "../src/adapters/virtualCards/CardLifecycle.js";
import type { MidenClient } from "../src/lib/clients/cardIssuing/miden/MidenClient.js";

const kyc: IndividualKyc = {
  firstName: "Test", lastName: "Person", dateOfBirth: "1990-01-01", idType: "PASSPORT", idNumber: "A1", idFrontImage: "data:image/png;base64,AA",
  phone: "+2348000000000", email: "t@example.com", address: { address1: "1 St", city: "Lagos", state: "Lagos", zipcode: "1", country: "NG" },
};

function fixture(kycStatus: string, failIssueFirst = false) {
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
  let issues = 0;
  const miden = {
    request: async (_m: string, path: string, body?: Record<string, unknown>) => {
      calls.push({ path, body });
      if (path === "/api/v1/cards/kyc-submit") return { isSuccessful: true, responseCode: "000" };
      if (path.startsWith("/api/v1/cards/kyc/client-reference/"))
        return { isSuccessful: true, responseCode: "000", kycStatus, customerId: "cust1", kycToken: "tok" };
      if (path === "/api/v2/cards/issue") {
        issues++;
        if (failIssueFirst && issues === 1) return { isSuccessful: false, responseCode: "150" };
        return { isSuccessful: true, responseCode: "000", data: { cardId: "card1" } };
      }
      throw new Error(`unexpected ${path}`);
    },
  } as unknown as MidenClient;
  const issuer = new TieredCardIssuer(new CardService(miden, { fund: async () => ({ id: "r", status: "pending" }) }));
  return { calls, onboarding: new Onboarding(new CardLifecycle(miden), issuer), issues: () => issues };
}

test("submitKyc sends a stable clientReference and the identity fields", async () => {
  const { onboarding, calls } = fixture("Approved");
  await onboarding.submitKyc("u1", kyc);
  const body = calls[0]!.body!;
  assert.equal(body.clientReference, "kyc-u1");
  assert.equal(body.customerType, "Individual");
});

test("pending KYC issues no card", async () => {
  const { onboarding, issues } = fixture("Pending");
  assert.deepEqual(await onboarding.status("u1"), { state: "pending", status: "Pending" });
  assert.equal(issues(), 0);
});

test("rejected KYC reports rejected", async () => {
  const { onboarding } = fixture("Rejected");
  assert.deepEqual(await onboarding.status("u1"), { state: "rejected" });
});

test("approved KYC issues exactly one card, even for concurrent status calls", async () => {
  const { onboarding, issues } = fixture("Approved");
  const [a, b] = await Promise.all([onboarding.status("u1"), onboarding.status("u1")]);
  await onboarding.status("u1");
  assert.equal(issues(), 1);
  assert.equal(a.state === "active" && b.state === "active" && a.card.id === b.card.id, true);
});

test("a failed issuance can be retried", async () => {
  const { onboarding, issues } = fixture("Approved", true);
  await assert.rejects(onboarding.status("u1"), /issuance failed/);
  const r = await onboarding.status("u1");
  assert.equal(r.state, "active");
  assert.equal(issues(), 2);
});
