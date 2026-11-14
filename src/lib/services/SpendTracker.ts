import type { AgentCard, AuthorizationResult } from "../../domain/interfaces/CardIssuing.js";
import { evaluate } from "./spendPolicy.js";

/** Approved spend per card per UTC day, in memory only (lost on restart). Shared by every card provider. */
export class SpendTracker {
  private readonly spent = new Map<string, Map<string, number>>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  /**
   * Checks a spend attempt against the card's policy and, if approved, records it
   * against today's total. Synchronous, so concurrent attempts cannot both pass the
   * daily limit within one process.
   */
  authorize(card: AgentCard, amountCents: number, mcc?: string): AuthorizationResult {
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
      return { ok: false, reason: "amount must be a positive whole number of cents" };
    }
    const day = this.now().toISOString().slice(0, 10);
    const days = this.spent.get(card.id) ?? new Map<string, number>();
    const spentTodayCents = days.get(day) ?? 0;
    const result = evaluate(card.policy, { amountCents, mcc, spentTodayCents });
    if (result.ok) {
      days.set(day, spentTodayCents + amountCents);
      // Keep every day seen until a newer one arrives, so a clock stepping back still finds its day;
      // only drop days more than 2 behind the latest.
      const latest = [...days.keys()].sort().at(-1)!;
      const cutoff = new Date(Date.parse(latest) - 2 * 86_400_000).toISOString().slice(0, 10);
      for (const d of days.keys()) if (d < cutoff) days.delete(d);
      this.spent.set(card.id, days);
    }
    return result;
  }
}
