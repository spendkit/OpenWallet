// Background work: chain watchers, and a 5-second tick that finishes
// KYC -> card, moves credited deposits onto cards, reconciles spends, delivers developer webhooks, reconciles
// hosted-checkout swaps and missed Circle deposits, syncs checkouts and sends payouts.
import { BaseUsdcWatcher } from "./adapters/deposits/BaseUsdcWatcher.js";
import type { AgentCardsApp } from "./createApp.js";
import type { AppParams } from "./domain/types/ContextTypes.js";

const errText = (e: unknown) => (e as Error).message;

export async function startBackgroundWorkers(
  params: Pick<AppParams, "ledger" | "addresses" | "watchedNetworks" | "log" | "walletMonitor" | "alerts">,
  app: AgentCardsApp,
): Promise<{ stop(): void }> {
  const { log } = params;
  const stop = new AbortController();

  for (const n of params.watchedNetworks) {
    if ((await n.cursor.get()) === undefined) {
      const head = Number.parseInt((await n.rpc("eth_blockNumber", [])) as string, 16);
      await n.cursor.set(head - 20);
    }
    const watcher = new BaseUsdcWatcher({
      rpc: n.rpc, ledger: params.ledger, addresses: params.addresses, cursor: n.cursor, chain: n.label, token: n.token, maxRange: 500,
      // Testnet: 5 blocks so a sandbox deposit shows quickly. On Base mainnet use finality: "finalized":
      // a card top-up cannot be undone, so a reorged deposit would be a loss.
      confirmations: n.confirmations, finality: n.label === "base" ? "finalized" : "confirmations",
      onDust: (d) => log(`dust ${d.dustBase} base units on ${d.txHash}:${d.logIndex} (not credited)`),
    });
    let lastChainError = "";
    void watcher.run(stop.signal, {
      intervalMs: 4_000,
      onError: (e) => {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg !== lastChainError) log(`chain watcher ${n.label}: ${msg}`);
        lastChainError = msg;
      },
    });
  }

  // Catch up on Circle deposits whose webhook never arrived (tunnel down, restart). At most once a minute.
  let lastCircleSweep = 0;
  const circleIgnoredLogged = new Set<string>();
  async function reconcileCircle(): Promise<void> {
    if (!app.circleDeposits || Date.now() - lastCircleSweep < 60_000) return;
    lastCircleSweep = Date.now();
    let r;
    try {
      r = await app.circleDeposits.reconcile();
    } catch (e) {
      await params.alerts?.raise("circle-reconcile", `Circle catch-up reconcile is failing: ${errText(e)}. Missed deposits will not be credited until it works.`);
      throw e;
    }
    await params.alerts?.clear("circle-reconcile", "Circle catch-up reconcile works again.");
    if (r.credited > 0) log(`circle reconcile: credited ${r.credited} missed deposit(s)`);
    for (const i of r.ignored) {
      if (circleIgnoredLogged.has(i.id)) continue;
      circleIgnoredLogged.add(i.id);
      log(`circle reconcile: transfer ${i.id} to one of our addresses not credited (${i.reason})`);
    }
  }

  // A top-up row is 'reserved' only between the ledger reserve and the Miden answer; it normally settles within a
  // tick. One that lingers means money is held and neither landed nor released. Checked at most once a minute.
  const STUCK_FUNDING_MS = Number(process.env.STUCK_FUNDING_MINUTES || 15) * 60_000;
  let lastFundingCheck = 0;
  async function checkStuckFundings(): Promise<void> {
    if (!params.alerts || Date.now() - lastFundingCheck < 60_000) return;
    lastFundingCheck = Date.now();
    const stuck = await app.cardholders.stuckFundings(STUCK_FUNDING_MS);
    if (stuck.length === 0) {
      await params.alerts.clear("stuck-funding", "No top-ups are stuck in 'reserved' any more.");
      return;
    }
    const oldest = stuck[0]!;
    await params.alerts.raise("stuck-funding", `${stuck.length} card top-up(s) stuck in 'reserved' for over ${Math.round(STUCK_FUNDING_MS / 60_000)} min (oldest ${oldest.fundingId}, card ${oldest.cardId}, ${oldest.amountCents} cents). See docs/runbook.md.`);
  }

  async function tick(): Promise<void> {
    const { cardholders } = app;
    for (const userId of await cardholders.pendingKycUsers()) await cardholders.refresh(userId).catch((e) => log(`kyc ${userId}: ${errText(e)}`));
    await cardholders.fundPending().catch((e) => log(`funding: ${errText(e)}`));
    await cardholders.reconcileSpends().catch((e) => log(`reconcile: ${errText(e)}`));
    // Not awaited: a slow webhook endpoint must not hold up reconcile and payouts (deliverDue is single-flight).
    if (app.developers) void app.developers.deliverDue().catch((e) => log(`webhooks: ${errText(e)}`));
    await app.swaps?.reconcile().catch((e) => log(`swap reconcile: ${errText(e)}`));
    await reconcileCircle().catch((e) => log(`circle reconcile: ${errText(e)}`));
    await checkStuckFundings().catch((e) => log(`stuck funding check: ${errText(e)}`));
    await params.walletMonitor?.check().catch((e) => log(`wallet monitor: ${errText(e)}`));
    await app.checkouts?.sync().catch((e) => log(`checkouts: ${errText(e)}`));
    await app.payouts?.tick().catch((e) => log(`payouts: ${errText(e)}`));
  }
  const timer = setInterval(() => void tick(), 5_000);

  return {
    stop() {
      stop.abort();
      clearInterval(timer);
    },
  };
}
