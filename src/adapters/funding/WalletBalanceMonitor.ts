import type { MidenClient } from "../../lib/clients/cardIssuing/miden/MidenClient.js";

interface BalancesResponse {
  data?: { walletNumber?: string; walletCurrency?: string; walletAvailableBalance?: number }[];
  isSuccessful?: boolean;
  responseCode?: string;
  responseMessage?: string;
}

export interface WalletBalanceMonitorOptions {
  miden: MidenClient;
  /** Alert when the USD wallet's spendable balance (dollars) is below this. */
  minUsd: number;
  log: (msg: string) => void;
  /** Optional: POSTed `{ text }` (Slack-compatible) when the state changes to low or back to ok. */
  alertWebhookUrl?: string;
  fetch?: typeof fetch;
  /** Minimum gap between Miden reads, ms. */
  intervalMs?: number;
  now?: () => number;
}

/**
 * Top-ups are paid from the Miden USD wallet, not from received USDC, so an empty wallet means funded cards
 * cannot be topped up. Reads GET api/v1/wallet/balances (walletAvailableBalance, USD) and alerts on the
 * transition to low and on recovery, not on every poll. A failed read is logged (and alerted, once): not knowing
 * the balance is itself something to know.
 */
export class WalletBalanceMonitor {
  private state: "ok" | "low" | "unknown" | undefined;
  private last = 0;
  constructor(private readonly o: WalletBalanceMonitorOptions) {}

  /** Last observed spendable USD balance, undefined before the first successful read. */
  lastBalanceUsd: number | undefined;

  async check(): Promise<void> {
    const now = (this.o.now ?? Date.now)();
    if (this.last && now - this.last < (this.o.intervalMs ?? 60_000)) return;
    this.last = now;
    let usd: number;
    try {
      const res = await this.o.miden.request<BalancesResponse>("GET", "/api/v1/wallet/balances?walletCurrency=USD");
      if (res.isSuccessful === false) throw new Error(`${res.responseCode ?? "?"} ${res.responseMessage ?? ""}`.trim());
      const wallets = (res.data ?? []).filter((w) => w.walletCurrency === undefined || w.walletCurrency === "USD");
      if (wallets.length === 0) throw new Error("no USD wallet in the response");
      usd = wallets.reduce((s, w) => s + (Number(w.walletAvailableBalance) || 0), 0);
    } catch (e) {
      await this.transition("unknown", `Miden USD wallet balance could not be read: ${(e as Error).message}`);
      return;
    }
    this.lastBalanceUsd = usd;
    if (usd < this.o.minUsd) await this.transition("low", `LOW BALANCE: Miden USD wallet has $${usd.toFixed(2)} available, below the $${this.o.minUsd.toFixed(2)} floor. Card top-ups will fail until it is funded.`);
    else await this.transition("ok", `Miden USD wallet balance ok again: $${usd.toFixed(2)} available.`);
  }

  private async transition(next: "ok" | "low" | "unknown", msg: string): Promise<void> {
    if (this.state === next) return;
    const first = this.state === undefined;
    this.state = next;
    if (next === "ok" && first) return; // healthy at boot: nothing to say
    this.o.log(`ALERT ${msg}`);
    if (!this.o.alertWebhookUrl) return;
    try {
      await (this.o.fetch ?? fetch)(this.o.alertWebhookUrl, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: msg }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      this.o.log(`ALERT webhook failed: ${(e as Error).message}`);
    }
  }
}
