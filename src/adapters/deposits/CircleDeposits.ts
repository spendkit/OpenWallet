import type { Ledger } from "../../lib/services/Ledger.js";
import { baseUnitsToCents } from "../../lib/utils/units.js";
import { CIRCLE_CHAINS, CIRCLE_USDC, CircleError, usdcToBaseUnits, verifyCircleSignature, type CircleClient, type CircleTx } from "../../lib/clients/circle/CircleClient.js";

const UNDER_ONE_CENT = "under one cent";

/** Circle notification key ids are UUIDs; anything else is refused before we ask Circle about it. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CircleOutcome =
  | { status: "credited"; cardId: string; amountCents: number; chain: string; isNew: boolean }
  | { status: "ignored"; reason: string };

export interface CircleDepositsDeps {
  circle: Pick<CircleClient, "notificationKey" | "transaction" | "token"> & Partial<Pick<CircleClient, "recentInbound">>;
  ledger: Ledger;
  addresses: { cardFor(address: string): Promise<string | undefined> };
  /** Called for every credit that was new (not a redelivery). */
  onCredited?: (r: Extract<CircleOutcome, { status: "credited" }>) => void;
  onDust?: (d: { txHash: string; dustBase: bigint }) => void;
  /** Server-side only: the real Circle status behind a failed key lookup (the caller just sees 401). */
  log?: (m: string) => void;
}

/** Turns Circle `transactions.inbound` webhooks into ledger credits. Throws on anything Circle should retry. */
export class CircleDeposits {
  constructor(private readonly d: CircleDepositsDeps) {}

  /** Transfers whose dust this process already reported: a sub-cent transfer is "ignored" again on every reconcile pass. Bounded. */
  private readonly dustReported = new Set<string>();
  private reportDust(txHash: string, dustBase: bigint): void {
    const k = txHash.toLowerCase();
    if (this.dustReported.has(k)) return;
    if (this.dustReported.size >= 5000) this.dustReported.clear();
    this.dustReported.add(k);
    this.d.onDust?.({ txHash, dustBase });
  }

  /** @throws CircleError with status 401 for a bad signature; any other throw means "retry later". */
  async handle(rawBody: string, headers: { signature?: string; keyId?: string }): Promise<CircleOutcome> {
    if (!headers.signature || !headers.keyId) throw new CircleError("missing signature headers", 401);
    if (!UUID.test(headers.keyId)) throw new CircleError("bad key id", 401);
    let key;
    try {
      key = await this.d.circle.notificationKey(headers.keyId);
    } catch (e) {
      if (e instanceof CircleError) this.d.log?.(`circle notification key lookup failed: ${e.message}`);
      // Circle not knowing the key id (400/404) is the caller's fault (401). Circle refusing our own API key
      // (401/403), rate limits and 5xx are ours: rethrown so the real cause is visible and Circle retries.
      if (e instanceof CircleError && (e.status === 400 || e.status === 404)) throw new CircleError("unknown key id", 401);
      throw e;
    }
    if (!verifyCircleSignature(rawBody, headers.signature, key.publicKey)) throw new CircleError("bad signature", 401);

    let body: { notificationType?: string; notification?: { id?: string } };
    try { body = JSON.parse(rawBody); } catch { return { status: "ignored", reason: "not JSON" }; }
    if (body.notificationType !== "transactions.inbound") return { status: "ignored", reason: `type ${String(body.notificationType)}` };
    const id = body.notification?.id;
    if (typeof id !== "string" || !id) return { status: "ignored", reason: "no transaction id" };

    // The signed body says which transaction; the amounts come from Circle's API, not from the body.
    return this.credit(await this.d.circle.transaction(id));
  }

  /**
   * Catch-up for webhooks Circle could not deliver (tunnel down, service restarting): credits every COMPLETE
   * inbound USDC transfer from the last `lookbackMs` that the ledger has not seen. Safe to run often: the
   * ledger key makes a repeat a no-op. Reads up to 10 pages of 50 (recentInbound), so a window busier than 500 transfers is only partly covered.
   */
  async reconcile(lookbackMs = 2 * 3600_000): Promise<{ checked: number; credited: number; ignored: { id: string; reason: string }[] }> {
    if (!this.d.circle.recentInbound) throw new Error("this Circle client cannot list transactions");
    const txs = await this.d.circle.recentInbound(new Date(Date.now() - lookbackMs));
    let credited = 0;
    const ignored: { id: string; reason: string }[] = [];
    for (const tx of txs) {
      const r = await this.credit(tx);
      if (r.status === "credited" && r.isNew) credited++;
      // Transfers to our own addresses that were not credited (wrong token, odd shape, sub-cent) are the ones to surface.
      // (A sub-cent transfer is reported once through onDust instead, so it is not repeated here.)
      if (r.status === "ignored" && r.reason !== "not one of our deposit addresses" && r.reason !== UNDER_ONE_CENT) ignored.push({ id: tx.id, reason: r.reason });
    }
    return { checked: txs.length, credited, ignored };
  }

  private async credit(tx: CircleTx): Promise<CircleOutcome> {
    if (tx.transactionType !== "INBOUND") return { status: "ignored", reason: "not inbound" };
    if (tx.state !== "COMPLETE") return { status: "ignored", reason: `state ${String(tx.state)}` };
    const chain = tx.blockchain ? CIRCLE_CHAINS[tx.blockchain] : undefined;
    if (!chain) return { status: "ignored", reason: `unsupported blockchain ${String(tx.blockchain)}` };
    // Cheapest checks first: most listed transfers are not to our addresses, and each token lookup is an API call.
    const cardId = tx.destinationAddress ? await this.d.addresses.cardFor(tx.destinationAddress) : undefined;
    if (!cardId) return { status: "ignored", reason: "not one of our deposit addresses" };
    const token = tx.tokenId ? await this.d.circle.token(tx.tokenId) : undefined;
    if (!token || token.symbol !== "USDC" || token.blockchain !== tx.blockchain || token.decimals !== 6 || token.tokenAddress?.toLowerCase() !== CIRCLE_USDC[tx.blockchain!]) {
      return { status: "ignored", reason: "not the pinned USDC contract" };
    }
    if (!tx.txHash || tx.amounts?.length !== 1) return { status: "ignored", reason: "unexpected transaction shape" };
    const base = usdcToBaseUnits(tx.amounts[0]!);
    if (!base || base === 0n) return { status: "ignored", reason: "bad amount" };
    const { cents, dustBase } = baseUnitsToCents(base, 6);
    if (cents === 0) {
      this.reportDust(tx.txHash, dustBase); // nothing to credit, but the money arrived: say so once
      return { status: "ignored", reason: UNDER_ONE_CENT };
    }

    const label = `circle-${chain}`;
    // Only for the log line: whether this call is the one that credits. The ledger key is what prevents a double credit.
    const isNew = !(await this.d.ledger.findByKey(`deposit:${label}:${tx.txHash.toLowerCase()}:0`));
    await this.d.ledger.confirmDeposit({ chain: label, asset: "USDC", cardId, amountCents: cents, txHash: tx.txHash, logIndex: 0 });
    const out = { status: "credited", cardId, amountCents: cents, chain, isNew } as const;
    if (isNew) {
      if (dustBase > 0n) this.reportDust(tx.txHash, dustBase);
      this.d.onCredited?.(out);
    }
    return out;
  }
}
