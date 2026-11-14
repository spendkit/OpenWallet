import { EventEmitter } from "node:events";

/**
 * Live view of hosted-checkout payments paid with Stripe's public test card (SWAP_STRIPE_TEST_CARD, sandbox only):
 * the filler's steps and screen frames, per agent, for a demo viewer. Swaps paid with a real card never publish here.
 * In memory, this process only; a viewer that connects late sees only what happens from then on.
 */
export type SwapLiveEvent =
  | { type: "start"; swapId: string; merchant: string; amountCents: number; url: string }
  | { type: "step"; swapId: string; label: string }
  | { type: "frame"; swapId: string; jpeg: string }
  | { type: "end"; swapId: string; outcome: string };

export class SwapLiveFeed {
  private readonly bus = new EventEmitter().setMaxListeners(100);

  publish(agentId: string, e: SwapLiveEvent): void {
    this.bus.emit(agentId, e);
  }

  /** Returns the unsubscribe function. */
  subscribe(agentId: string, fn: (e: SwapLiveEvent) => void): () => void {
    this.bus.on(agentId, fn);
    return () => this.bus.off(agentId, fn);
  }
}
