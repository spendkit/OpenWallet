import { createHash, createPublicKey, publicEncrypt, randomUUID, verify, constants } from "node:crypto";
import { BASE_USDC, BASE_SEPOLIA_USDC, ETHEREUM_SEPOLIA_USDC } from "../../../adapters/deposits/BaseUsdcWatcher.js";

/**
 * Circle developer-controlled wallets as the deposit rail (sandbox): each card gets a Circle wallet created on
 * the fly, and Circle tells us about inbound USDC by webhook instead of us polling a chain. API shapes follow
 * developers.circle.com (create wallet, notification subscriptions, notification signatures); the inbound
 * payload field names have not yet been checked against a live Circle delivery, so the handler re-reads the
 * transaction from Circle's API and trusts that, not the webhook body.
 */

export const CIRCLE_API = "https://api.circle.com";
/** Circle blockchain id -> the ledger chain label the watcher rail already uses for that network. */
export const CIRCLE_CHAINS: Record<string, string> = { BASE: "base", "BASE-SEPOLIA": "base-sepolia", "ETH-SEPOLIA": "ethereum-sepolia" };
/** The only USDC contract credited per Circle blockchain: a token that merely calls itself "USDC" is not enough. */
export const CIRCLE_USDC: Record<string, string> = { BASE: BASE_USDC, "BASE-SEPOLIA": BASE_SEPOLIA_USDC, "ETH-SEPOLIA": ETHEREUM_SEPOLIA_USDC };

/**
 * Which Circle environment this process talks to. A TEST_API_KEY only works on testnets and a live key only on
 * mainnet, so the pairing is checked up front instead of failing (or worse, half-working) on the first call.
 * Going live is deliberate: CIRCLE_NETWORK=BASE together with CIRCLE_LIVE=1 and a live key. Default is the sandbox.
 */
export function circleNetwork(env: { CIRCLE_API_KEY?: string; CIRCLE_NETWORK?: string; CIRCLE_LIVE?: string }): "BASE" | "BASE-SEPOLIA" {
  const net = env.CIRCLE_NETWORK ?? "BASE-SEPOLIA";
  if (net !== "BASE" && net !== "BASE-SEPOLIA") throw new Error("CIRCLE_NETWORK must be BASE-SEPOLIA (default) or BASE");
  const isTestKey = (env.CIRCLE_API_KEY ?? "").startsWith("TEST_API_KEY:");
  if (net === "BASE-SEPOLIA" && !isTestKey) throw new Error("CIRCLE_NETWORK is BASE-SEPOLIA but CIRCLE_API_KEY is not a TEST_API_KEY: a live key is only for CIRCLE_NETWORK=BASE");
  if (net === "BASE") {
    if (isTestKey) throw new Error("CIRCLE_NETWORK=BASE needs a live Circle API key, not a TEST_API_KEY");
    if (env.CIRCLE_LIVE !== "1") throw new Error("CIRCLE_NETWORK=BASE moves real money: set CIRCLE_LIVE=1 to confirm");
  }
  return net;
}
/** Unknown notification key ids we will look up per minute, so an anonymous caller cannot make us spam Circle. */
const KEY_LOOKUPS_PER_MIN = 20;
const RECENT_PAGES = 10;

type Fetch = typeof fetch;

export interface CircleOptions {
  apiKey: string;
  /** 32 random bytes as 64 hex characters, registered with Circle (see docs/circle-deposits.md). */
  entitySecretHex: string;
  walletSetId: string;
  blockchain?: string;
  baseUrl?: string;
  fetch?: Fetch;
}

export class CircleError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/** A UUID derived from text, so retrying "create the wallet for index 7" is the same request to Circle. */
export function uuidFrom(text: string): string {
  const h = createHash("sha256").update(text).digest();
  h[6] = (h[6]! & 0x0f) | 0x40;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export class CircleClient {
  private readonly base: string;
  private readonly f: Fetch;
  private pem: string | undefined;
  private readonly keys = new Map<string, { algorithm: string; publicKey: string }>();
  private lookups: number[] = [];
  private readonly tokens = new Map<string, CircleToken>();

  constructor(private readonly o: CircleOptions) {
    if (!/^[0-9a-fA-F]{64}$/.test(o.entitySecretHex)) throw new Error("the Circle entity secret must be 64 hex characters");
    this.base = o.baseUrl ?? CIRCLE_API;
    this.f = o.fetch ?? fetch;
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await this.f(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.o.apiKey}`, "content-type": "application/json", "x-request-id": randomUUID() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = "";
      try { msg = (JSON.parse(text) as { message?: string }).message ?? ""; } catch { /* not JSON */ }
      throw new CircleError(`Circle ${method} ${path} -> ${res.status}${msg ? `: ${msg}` : ""}`, res.status);
    }
    return JSON.parse(text) as T;
  }

  /** The entity secret, RSA-OAEP (SHA-256) encrypted with Circle's public key. Circle wants a fresh one per request. */
  async entitySecretCiphertext(): Promise<string> {
    this.pem ??= (await this.call<{ data: { publicKey: string } }>("GET", "/v1/w3s/config/entity/publicKey")).data.publicKey;
    return publicEncrypt(
      { key: this.pem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from(this.o.entitySecretHex, "hex"),
    ).toString("base64");
  }

  /** One wallet for a deposit index. The idempotency key is derived from the index: a retry returns the same wallet. */
  async createDepositWallet(index: number): Promise<{ id: string; address: string }> {
    const r = await this.call<{ data: { wallets: { id: string; address: string }[] } }>("POST", "/v1/w3s/developer/wallets", {
      idempotencyKey: uuidFrom(`agent-cards-deposit-wallet:${this.o.walletSetId}:${index}`),
      entitySecretCiphertext: await this.entitySecretCiphertext(),
      walletSetId: this.o.walletSetId,
      blockchains: [this.o.blockchain ?? "BASE-SEPOLIA"],
      accountType: "EOA",
      count: 1,
      metadata: [{ name: `agent-cards deposit ${index}`, refId: String(index) }],
    });
    const w = r.data.wallets[0];
    if (!w || !/^0x[0-9a-fA-F]{40}$/.test(w.address)) throw new CircleError("Circle returned no usable wallet address");
    return { id: w.id, address: w.address.toLowerCase() };
  }

  async createWalletSet(name: string): Promise<string> {
    const r = await this.call<{ data: { walletSet: { id: string } } }>("POST", "/v1/w3s/developer/walletSets", {
      idempotencyKey: randomUUID(), entitySecretCiphertext: await this.entitySecretCiphertext(), name,
    });
    return r.data.walletSet.id;
  }

  /** Points Circle's webhooks at `endpoint` (public HTTPS). */
  async subscribe(endpoint: string): Promise<{ id: string }> {
    return (await this.call<{ data: { id: string } }>("POST", "/v2/notifications/subscriptions", { endpoint, notificationTypes: ["transactions.inbound"] })).data;
  }

  async notificationKey(keyId: string): Promise<{ algorithm: string; publicKey: string }> {
    const hit = this.keys.get(keyId);
    if (hit) return hit;
    // Only lookups that fail count against the budget, so unknown ids cannot starve a key we have not cached yet
    // while every successful lookup is cached for good. Known-good traffic is never throttled.
    const t = Date.now();
    this.lookups = this.lookups.filter((x) => t - x < 60_000);
    if (this.lookups.length >= KEY_LOOKUPS_PER_MIN) throw new CircleError("too many failed notification key lookups", 429);
    let k: { algorithm: string; publicKey: string };
    try {
      k = (await this.call<{ data: { algorithm: string; publicKey: string } }>("GET", `/v2/notifications/publicKey/${encodeURIComponent(keyId)}`)).data;
    } catch (e) {
      this.lookups.push(Date.now());
      throw e;
    }
    this.keys.set(keyId, k);
    return k;
  }

  async transaction(id: string): Promise<CircleTx> {
    return (await this.call<{ data: { transaction: CircleTx } }>("GET", `/v1/w3s/transactions/${encodeURIComponent(id)}`)).data.transaction;
  }

  /**
   * Inbound transactions since `from`, newest first, following `pageAfter` (older) up to RECENT_PAGES pages of 50 for
   * catching up on missed webhooks. Stops early on a short page or one that adds nothing new (cursor ignored).
   */
  async recentInbound(from: Date): Promise<CircleTx[]> {
    const out: CircleTx[] = [];
    const seen = new Set<string>();
    let after: string | undefined;
    for (let page = 0; page < RECENT_PAGES; page++) {
      const q = new URLSearchParams({ txType: "INBOUND", state: "COMPLETE", blockchain: this.o.blockchain ?? "BASE-SEPOLIA", from: from.toISOString(), pageSize: "50" });
      if (after) q.set("pageAfter", after);
      const txs = (await this.call<{ data: { transactions: CircleTx[] } }>("GET", `/v1/w3s/transactions?${q}`)).data.transactions;
      const fresh = txs.filter((t) => !seen.has(t.id));
      for (const t of fresh) { seen.add(t.id); out.push(t); }
      if (txs.length < 50 || fresh.length === 0) break;
      after = txs[txs.length - 1]!.id;
    }
    return out;
  }

  async token(tokenId: string): Promise<CircleToken> {
    const hit = this.tokens.get(tokenId);
    if (hit) return hit;
    const t = (await this.call<{ data: { token: CircleToken } }>("GET", `/v1/w3s/tokens/${encodeURIComponent(tokenId)}`)).data.token;
    this.tokens.set(tokenId, t);
    return t;
  }
}

export interface CircleToken { symbol?: string; blockchain?: string; tokenAddress?: string; decimals?: number }

export interface CircleTx {
  id: string;
  blockchain?: string;
  tokenId?: string;
  destinationAddress?: string;
  transactionType?: string;
  state?: string;
  amounts?: string[];
  txHash?: string;
}

/** Verifies Circle's ECDSA-SHA256 signature over the raw request body. The key is base64 SPKI DER (or PEM). */
export function verifyCircleSignature(rawBody: string, signatureB64: string, publicKey: string): boolean {
  try {
    const key = publicKey.includes("BEGIN") ? createPublicKey(publicKey) : createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
    return verify("sha256", Buffer.from(rawBody, "utf8"), key, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

/** A decimal USDC amount ("12.5") to 6-decimal base units; null for anything that is not a plain positive decimal. */
export function usdcToBaseUnits(amount: string): bigint | null {
  const m = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(amount.trim());
  if (!m) return null;
  return BigInt(m[1]! + (m[2] ?? "").padEnd(6, "0"));
}
