import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, privateDecrypt, sign, constants } from "node:crypto";
import { CircleDeposits } from "../src/adapters/deposits/CircleDeposits.js";
import { CircleClient, CircleError, circleNetwork, usdcToBaseUnits, uuidFrom, type CircleTx } from "../src/lib/clients/circle/CircleClient.js";
import { BASE_SEPOLIA_USDC } from "../src/adapters/deposits/BaseUsdcWatcher.js";
import { Ledger, accounts } from "../src/lib/services/Ledger.js";

const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pub = ec.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const signBody = (b: string) => sign("sha256", Buffer.from(b), ec.privateKey).toString("base64");

const ADDR = "0x" + "ab".repeat(20);
function setup(tx: Partial<CircleTx> = {}, symbol = "USDC") {
  const ledger = new Ledger();
  const full: CircleTx = { id: "t1", blockchain: "BASE-SEPOLIA", tokenId: "tok", destinationAddress: ADDR, transactionType: "INBOUND", state: "COMPLETE", amounts: ["12.345678"], txHash: "0xAAA", ...tx };
  const circle = { notificationKey: async () => ({ algorithm: "ECDSA_SHA_256", publicKey: pub }), transaction: async () => full, token: async () => ({ symbol, blockchain: "BASE-SEPOLIA", tokenAddress: BASE_SEPOLIA_USDC.toUpperCase().replace("0X","0x"), decimals: 6 }) };
  const dust: bigint[] = [];
  const d = new CircleDeposits({ circle, ledger, addresses: { cardFor: async (a) => (a.toLowerCase() === ADDR ? "card1" : undefined) }, onDust: (x) => dust.push(x.dustBase) });
  const body = JSON.stringify({ notificationType: "transactions.inbound", notification: { id: "t1", amounts: ["999"] } });
  return { ledger, d, body, dust };
}
const hdr = (b: string) => ({ signature: signBody(b), keyId: "0b1a7c59-8d4e-4f3a-9c21-5e6f7a8b9c0d" });

test("a signed inbound USDC webhook credits the card once, from Circle's own amount", async () => {
  const s = setup();
  const r = await s.d.handle(s.body, hdr(s.body));
  assert.deepEqual(r, { status: "credited", cardId: "card1", amountCents: 1234, chain: "base-sepolia", isNew: true });
  assert.deepEqual(s.dust, [5678n]);
  const again = await s.d.handle(s.body, hdr(s.body)); // Circle delivers at least once
  assert.equal((again as { isNew: boolean }).isNew, false);
  assert.equal(await s.ledger.balance(accounts.holding("card1")), 1234);
});

test("bad or missing signatures are refused and credit nothing", async () => {
  const s = setup();
  await assert.rejects(s.d.handle(s.body, { signature: signBody(s.body + " "), keyId: "0b1a7c59-8d4e-4f3a-9c21-5e6f7a8b9c0d" }), /bad signature/);
  await assert.rejects(s.d.handle(s.body, {}), /missing signature/);
  assert.equal(await s.ledger.balance(accounts.holding("card1")), 0);
});

test("ignored: not complete, not USDC, outbound, unknown address, unsupported chain", async () => {
  for (const [tx, sym, why] of [
    [{ state: "CONFIRMED" }, "USDC", /state/], [{}, "EURC", /pinned USDC/], [{ transactionType: "OUTBOUND" }, "USDC", /not inbound/],
    [{ destinationAddress: "0x" + "cd".repeat(20) }, "USDC", /not one of ours|not one of our/], [{ blockchain: "ETH" }, "USDC", /unsupported/],
  ] as const) {
    const s = setup(tx, sym);
    const r = await s.d.handle(s.body, hdr(s.body));
    assert.equal(r.status, "ignored");
    assert.match((r as { reason: string }).reason, why);
    assert.equal(await s.ledger.balance(accounts.holding("card1")), 0);
  }
});

test("reconcile credits a missed deposit once and is a no-op on the next pass", async () => {
  const s = setup();
  const credited: number[] = [];
  const full: CircleTx = { id: "t9", blockchain: "BASE-SEPOLIA", tokenId: "tok", destinationAddress: ADDR, transactionType: "INBOUND", state: "COMPLETE", amounts: ["5"], txHash: "0xBBB" };
  const other: CircleTx = { ...full, id: "t8", txHash: "0xCCC", destinationAddress: "0x" + "cd".repeat(20) };
  const d = new CircleDeposits({
    circle: { notificationKey: async () => ({ algorithm: "", publicKey: pub }), transaction: async () => full, token: async () => ({ symbol: "USDC", blockchain: "BASE-SEPOLIA", tokenAddress: BASE_SEPOLIA_USDC, decimals: 6 }), recentInbound: async () => [full, other] },
    ledger: s.ledger, addresses: { cardFor: async (a) => (a.toLowerCase() === ADDR ? "card1" : undefined) }, onCredited: (r) => credited.push(r.amountCents),
  });
  assert.deepEqual(await d.reconcile(), { checked: 2, credited: 1, ignored: [] });
  assert.deepEqual(await d.reconcile(), { checked: 2, credited: 0, ignored: [] });
  assert.deepEqual(credited, [500]);
  assert.equal(await s.ledger.balance(accounts.holding("card1")), 500);
});

test("a sub-cent-only transfer is logged as dust once, and reconcile neither repeats it nor lists it as ignored", async () => {
  const s = setup();
  const tiny: CircleTx = { id: "t7", blockchain: "BASE-SEPOLIA", tokenId: "tok", destinationAddress: ADDR, transactionType: "INBOUND", state: "COMPLETE", amounts: ["0.004"], txHash: "0xEEE" };
  const dust: bigint[] = [];
  const d = new CircleDeposits({
    circle: { notificationKey: async () => ({ algorithm: "", publicKey: pub }), transaction: async () => tiny, token: async () => ({ symbol: "USDC", blockchain: "BASE-SEPOLIA", tokenAddress: BASE_SEPOLIA_USDC, decimals: 6 }), recentInbound: async () => [tiny] },
    ledger: s.ledger, addresses: { cardFor: async (a) => (a.toLowerCase() === ADDR ? "card1" : undefined) }, onDust: (x) => dust.push(x.dustBase),
  });
  assert.deepEqual(await d.reconcile(), { checked: 1, credited: 0, ignored: [] });
  assert.deepEqual(await d.reconcile(), { checked: 1, credited: 0, ignored: [] });
  assert.equal(((await d.handle(s.body, hdr(s.body))) as { reason: string }).reason, "under one cent"); // webhook path too
  assert.deepEqual(dust, [4000n]);
  assert.equal(await s.ledger.balance(accounts.holding("card1")), 0);
});

test("a token called USDC at the wrong contract is not credited", async () => {
  const s = setup();
  const bad = new CircleDeposits({
    circle: { notificationKey: async () => ({ algorithm: "", publicKey: pub }), transaction: async () => ({ id: "t1", blockchain: "BASE-SEPOLIA", tokenId: "tok", destinationAddress: ADDR, transactionType: "INBOUND", state: "COMPLETE", amounts: ["5"], txHash: "0xDDD" }), token: async () => ({ symbol: "USDC", blockchain: "BASE-SEPOLIA", tokenAddress: "0x" + "11".repeat(20), decimals: 6 }) },
    ledger: s.ledger, addresses: { cardFor: async () => "card1" },
  });
  assert.match(((await bad.handle(s.body, hdr(s.body))) as { reason: string }).reason, /pinned USDC/);
  assert.equal(await s.ledger.balance(accounts.holding("card1")), 0);
});

test("a key id that is not a UUID, or that Circle does not know, is a 401 without a lookup storm", async () => {
  const s = setup();
  await assert.rejects(s.d.handle(s.body, { signature: signBody(s.body), keyId: "../x" }), /bad key id/);
  const unknown = new CircleDeposits({
    circle: { notificationKey: async () => { throw new CircleError("Circle GET -> 404", 404); }, transaction: async () => ({ id: "t" }), token: async () => ({}) },
    ledger: s.ledger, addresses: { cardFor: async () => undefined },
  });
  await assert.rejects(unknown.handle(s.body, { signature: signBody(s.body), keyId: "0b1a7c59-8d4e-4f3a-9c21-5e6f7a8b9c0d" }), (e: unknown) => e instanceof CircleError && e.status === 401);
  // Circle refusing our own API key is our fault: not disguised as "unknown key id".
  const refused = new CircleDeposits({
    circle: { notificationKey: async () => { throw new CircleError("Circle GET -> 403", 403); }, transaction: async () => ({ id: "t" }), token: async () => ({}) },
    ledger: s.ledger, addresses: { cardFor: async () => undefined },
  });
  await assert.rejects(refused.handle(s.body, { signature: signBody(s.body), keyId: "0b1a7c59-8d4e-4f3a-9c21-5e6f7a8b9c0d" }), (e: unknown) => e instanceof CircleError && e.status === 403);
});

test("circleNetwork pairs key type and network and needs CIRCLE_LIVE=1 for mainnet", () => {
  const T = "TEST_API_KEY:a:b", L = "LIVEKEY:a:b";
  assert.equal(circleNetwork({ CIRCLE_API_KEY: T }), "BASE-SEPOLIA");
  assert.throws(() => circleNetwork({ CIRCLE_API_KEY: L }), /not a TEST_API_KEY/);
  assert.throws(() => circleNetwork({ CIRCLE_API_KEY: T, CIRCLE_NETWORK: "BASE", CIRCLE_LIVE: "1" }), /live Circle API key/);
  assert.throws(() => circleNetwork({ CIRCLE_API_KEY: L, CIRCLE_NETWORK: "BASE" }), /CIRCLE_LIVE=1/);
  assert.throws(() => circleNetwork({ CIRCLE_API_KEY: L, CIRCLE_NETWORK: "ETH" }), /must be/);
  assert.equal(circleNetwork({ CIRCLE_API_KEY: L, CIRCLE_NETWORK: "BASE", CIRCLE_LIVE: "1" }), "BASE");
});

test("amount parsing is strict", () => {
  assert.equal(usdcToBaseUnits("1"), 1_000_000n);
  assert.equal(usdcToBaseUnits("0.01"), 10_000n);
  for (const bad of ["-1", "1e6", "1.1234567", "", "abc", "1,5"]) assert.equal(usdcToBaseUnits(bad), null);
});

test("wallet creation sends a decryptable entity secret and a stable idempotency key", async () => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const secret = "ab".repeat(32);
  const calls: { url: string; body?: any }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, body });
    const data = url.endsWith("/publicKey") ? { publicKey: rsa.publicKey.export({ type: "spki", format: "pem" }) } : { wallets: [{ id: "w1", address: ADDR.toUpperCase().replace("0X", "0x") }] };
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as typeof fetch;
  const c = new CircleClient({ apiKey: "TEST_API_KEY:a:b", entitySecretHex: secret, walletSetId: "ws", fetch: f });
  assert.deepEqual(await c.createDepositWallet(7), { id: "w1", address: ADDR });
  await c.createDepositWallet(7);
  const posts = calls.filter((x) => x.body);
  assert.equal(posts[0]!.body.idempotencyKey, posts[1]!.body.idempotencyKey);
  assert.equal(posts[0]!.body.idempotencyKey, uuidFrom("agent-cards-deposit-wallet:ws:7"));
  assert.notEqual(posts[0]!.body.entitySecretCiphertext, posts[1]!.body.entitySecretCiphertext); // fresh per request
  const plain = privateDecrypt({ key: rsa.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(posts[0]!.body.entitySecretCiphertext, "base64"));
  assert.equal(plain.toString("hex"), secret);
  assert.deepEqual(posts[0]!.body.blockchains, ["BASE-SEPOLIA"]);
});

test("only failed key lookups use the budget, so unknown ids cannot starve a good key", async () => {
  const good = "0b1a7c59-8d4e-4f3a-9c21-5e6f7a8b9c0d";
  const f = (async (url: string) => (String(url).endsWith(good)
    ? new Response(JSON.stringify({ data: { algorithm: "x", publicKey: "k" } }), { status: 200 })
    : new Response(JSON.stringify({ message: "nope" }), { status: 404 }))) as typeof fetch;
  const c = new CircleClient({ apiKey: "TEST_API_KEY:a:b", entitySecretHex: "ab".repeat(32), walletSetId: "ws", fetch: f });
  for (let i = 0; i < 20; i++) await assert.rejects(c.notificationKey(`1b1a7c59-8d4e-4f3a-9c21-5e6f7a8b9c${String(i).padStart(2, "0")}`), /404/);
  await assert.rejects(c.notificationKey("2b1a7c59-8d4e-4f3a-9c21-5e6f7a8b9c0d"), (e: unknown) => e instanceof CircleError && e.status === 429);
  // Successful lookups are cached and never counted, so a good key is unaffected by the failures above.
  const fresh = new CircleClient({ apiKey: "TEST_API_KEY:a:b", entitySecretHex: "ab".repeat(32), walletSetId: "ws", fetch: f });
  for (let i = 0; i < 5; i++) await fresh.notificationKey(good); // successes never count
  assert.equal((await fresh.notificationKey(good)).publicKey, "k");
});

test("recentInbound follows pageAfter and stops when a page adds nothing", async () => {
  const mk = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ id: `t${from + i}` }));
  const urls: string[] = [];
  const f = (async (url: string) => {
    urls.push(String(url));
    const after = new URL(String(url)).searchParams.get("pageAfter");
    const txs = after === null ? mk(50, 0) : after === "t49" ? mk(10, 50) : [];
    return new Response(JSON.stringify({ data: { transactions: txs } }), { status: 200 });
  }) as typeof fetch;
  const c = new CircleClient({ apiKey: "TEST_API_KEY:a:b", entitySecretHex: "ab".repeat(32), walletSetId: "ws", fetch: f });
  assert.equal((await c.recentInbound(new Date())).length, 60);
  assert.equal(urls.length, 2);
});
