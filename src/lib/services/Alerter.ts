export interface AlerterOptions {
  log: (msg: string) => void;
  /** Optional: POSTed `{ text }` (Slack-compatible). Without it alerts are only logged. */
  webhookUrl?: string;
  fetch?: typeof fetch;
  /** While a problem stays raised, repeat the alert at most this often, ms. Default 1h. */
  repeatMs?: number;
  now?: () => number;
}

/**
 * Keyed alerts that do not spam: `raise` sends the first time a key goes bad and again only after `repeatMs`
 * if it is still bad; `clear` sends one "recovered" line if the key had been raised. A failed webhook is logged,
 * never thrown, so alerting can never break the caller.
 */
export class Alerter {
  private readonly raised = new Map<string, number>();
  constructor(private readonly o: AlerterOptions) {}

  async raise(key: string, msg: string): Promise<void> {
    const now = (this.o.now ?? Date.now)();
    const last = this.raised.get(key);
    if (last !== undefined && now - last < (this.o.repeatMs ?? 3_600_000)) return;
    this.raised.set(key, now);
    await this.send(`ALERT ${msg}`);
  }

  async clear(key: string, msg: string): Promise<void> {
    if (!this.raised.delete(key)) return;
    await this.send(`RECOVERED ${msg}`);
  }

  private async send(text: string): Promise<void> {
    this.o.log(text);
    if (!this.o.webhookUrl) return;
    try {
      await (this.o.fetch ?? fetch)(this.o.webhookUrl, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      this.o.log(`ALERT webhook failed: ${(e as Error).message}`);
    }
  }
}
