import type { CircleDeposits } from "./adapters/deposits/CircleDeposits.js";
import type { AppParams } from "./domain/types/ContextTypes.js";
import { CardholderInteractor } from "./lib/interactors/CardholderInteractor.js";
import { CheckoutInteractor } from "./lib/interactors/CheckoutInteractor.js";
import { DeveloperInteractor } from "./lib/interactors/DeveloperInteractor.js";
import { PayoutInteractor } from "./lib/interactors/PayoutInteractor.js";
import { SwapInteractor } from "./lib/interactors/SwapInteractor.js";
import type { Alerter } from "./lib/services/Alerter.js";
import { SwapLiveFeed } from "./lib/services/SwapLiveFeed.js";

/**
 * The interactors the controllers call, by area. Optional ones are features a server may run without; their
 * routes answer 404 then (lib/utils/requireFeature.ts).
 */
export interface AgentCardsApp {
  /** Owners, their card, KYC, deposits, agents and agent payments. */
  cardholders: CardholderInteractor;
  checkouts?: CheckoutInteractor;
  swaps?: SwapInteractor;
  /** Live view of test-card swaps; only when SWAP_STRIPE_TEST_CARD=1 (sandbox). */
  swapLive?: SwapLiveFeed;
  developers?: DeveloperInteractor;
  payouts?: PayoutInteractor;
  circleDeposits?: CircleDeposits;
  alerts?: Alerter;
  log?: (msg: string) => void;
}

/** Builds the interactors from what bootstrap made. */
export function createApp(p: AppParams): AgentCardsApp & Required<Pick<AgentCardsApp, "checkouts" | "developers" | "payouts">> {
  // Developers are told about cardholder events, and the developer interactor needs the cardholder one:
  // tie the knot with a late binding.
  let developers: DeveloperInteractor | undefined;
  const cardholders = new CardholderInteractor({
    users: p.repos.users, cards: p.repos.cards, agents: p.repos.agents, spends: p.repos.spends, fundings: p.repos.fundings,
    oneTimeCards: p.repos.oneTimeCards,
    ledger: p.ledger, lifecycle: p.lifecycle, cardIssuer: p.cards, funding: p.funding,
    wallets: p.wallets, addresses: p.addresses, deriveAddress: p.deriveAddress, tiers: p.tiers, chain: p.chain,
    sandbox: p.sandbox, simulatedDeposits: p.simulatedDeposits, log: p.log,
    ...(p.depositNetworks ? { depositNetworks: p.depositNetworks } : {}),
    ...(p.depositRail ? { depositRail: p.depositRail } : {}),
    onEvent: (userId, type, data) => developers?.onEvent(userId, type, data) ?? Promise.resolve(),
  });
  developers = new DeveloperInteractor({ developers: p.repos.developers, webhookEvents: p.repos.webhookEvents, app: cardholders, allowLocalWebhooks: p.allowLocalWebhooks, publicUrl: p.publicUrl, log: p.log });
  const checkouts = new CheckoutInteractor({
    merchants: p.repos.merchants, checkouts: p.repos.checkouts, payouts: p.repos.payouts,
    ledger: p.ledger, app: cardholders, publicUrl: p.publicUrl, log: p.log,
    payoutAddressDelayMs: p.payoutAddressDelayMs, isOwnAddress: p.isOwnAddress,
  });
  const live = p.swapConfig.enabled && p.swapConfig.stripeTestCard ? new SwapLiveFeed() : undefined;
  const swaps = p.swapConfig.enabled && p.vault
    ? new SwapInteractor({ swaps: p.repos.swaps, app: cardholders, vault: p.vault, filler: p.checkoutFiller, lifecycle: p.lifecycle, config: p.swapConfig, live, log: p.log })
    : undefined;
  const payouts = new PayoutInteractor({ db: p.db, payouts: p.repos.payouts, ledger: p.ledger, checkout: checkouts, rail: p.payoutRail, log: p.log });
  return { cardholders, checkouts, swaps, swapLive: swaps ? live : undefined, developers, payouts, circleDeposits: p.circleDeposits, alerts: p.alerts, log: p.log };
}
