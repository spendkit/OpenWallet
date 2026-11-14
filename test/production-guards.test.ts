import { test } from "node:test";
import assert from "node:assert/strict";
import { bootstrapApplication } from "../src/bootstrap.js";
import { MidenClient } from "../src/lib/clients/cardIssuing/miden/MidenClient.js";
import { WalletBalanceMonitor } from "../src/adapters/funding/WalletBalanceMonitor.js";

// Every guard case below must throw before bootstrap opens a database connection.
const prod = {
  APP_ENV: "production", CARD_PROVIDER: "miden", MIDEN_CLIENT_ID: "id", MIDEN_CLIENT_SECRET: "s", MIDEN_UNIQUE_KEY: "u",
  MIDEN_BASE_URL: "https://api.miden.example/miden", MIDEN_TOKEN_URL: "https://id.miden.example/connect/token",
};
const rejects = (env: Record<string, string>, re: RegExp) => assert.rejects(bootstrapApplication(env as NodeJS.ProcessEnv), re);

test("production refuses simulated deposits, even when asked", () => rejects({ ...prod, ALLOW_SIMULATED_DEPOSITS: "1" }, /ALLOW_SIMULATED_DEPOSITS=1 is not allowed/));
test("production refuses the Stripe test-card swap", () => rejects({ ...prod, SWAP_STRIPE_TEST_CARD: "1" }, /SWAP_STRIPE_TEST_CARD=1 is not allowed/));
test("production refuses a sandbox Miden host", () => rejects({ ...prod, MIDEN_BASE_URL: "https://sandbox-api.midencards.io/miden" }, /sandbox host/));
test("production has no sandbox URL defaults", () => rejects({ ...prod, MIDEN_TOKEN_URL: "" }, /needs MIDEN_TOKEN_URL/));
test("production refuses http", () => rejects({ ...prod, MIDEN_BASE_URL: "http://api.miden.example/miden" }, /must be https/));
test("production refuses the mock provider", () => rejects({ ...prod, CARD_PROVIDER: "mock" }, /needs CARD_PROVIDER=miden/));
test("without APP_ENV=production a non-sandbox Miden host is refused", () =>
  rejects({ ...prod, APP_ENV: "sandbox", MIDEN_BASE_URL: "https://api.miden.example/miden" }, /sandbox-only unless APP_ENV=production/));
test("unknown APP_ENV is refused", () => rejects({ ...prod, APP_ENV: "prod" }, /APP_ENV must be/));

function monitor(balances: () => Response, minUsd = 100) {
  const logs: string[] = [];
  const hooks: string[] = [];
  let t = 0;
  const f = (async (url: string | URL | Request) => {
    if (String(url).endsWith("/connect/token")) return Response.json({ access_token: "tok", expires_in: 3600 });
    return balances();
  }) as typeof fetch;
  const miden = new MidenClient({ baseUrl: "https://api.test/miden", tokenUrl: "https://id.test/connect/token", clientId: "i", clientSecret: "s", uniqueKey: "u", fetch: f });
  const hookFetch = (async (_u: string, init: RequestInit) => { hooks.push(JSON.parse(init.body as string).text); return new Response("ok"); }) as unknown as typeof fetch;
  const m = new WalletBalanceMonitor({ miden, minUsd, log: (s) => logs.push(s), alertWebhookUrl: "https://hook.test/x", fetch: hookFetch, now: () => (t += 61_000) });
  return { m, logs, hooks };
}
const bal = (usd: number) => () => Response.json({ isSuccessful: true, responseCode: "000", data: [{ walletCurrency: "USD", walletAvailableBalance: usd }] });

test("monitor alerts once on low, stays quiet while low, and says when recovered", async () => {
  let cur = bal(50);
  const { m, logs, hooks } = monitor(() => cur());
  await m.check(); await m.check();
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /LOW BALANCE.*\$50\.00.*\$100\.00/);
  assert.equal(hooks.length, 1);
  cur = bal(500);
  await m.check();
  assert.match(logs[1]!, /ok again.*\$500\.00/);
});

test("monitor is silent when healthy at boot", async () => {
  const { m, logs } = monitor(bal(500));
  await m.check();
  assert.deepEqual(logs, []);
});

test("monitor alerts when the balance cannot be read", async () => {
  const { m, logs } = monitor(() => new Response("nope", { status: 500 }));
  await m.check();
  assert.match(logs[0]!, /could not be read/);
});
