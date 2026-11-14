import type pg from "pg";
import type { Database } from "../../db/client.js";
import type { Repositories } from "../../db/repositories/createRepositories.js";
import type { DepositAddressRepository } from "../repositories/DepositAddressRepository.js";
import type { CardVault } from "../../adapters/cardVault/CardVault.js";
import type { CheckoutFiller } from "../../adapters/checkoutFillers/CheckoutFiller.js";
import type { CircleDeposits } from "../../adapters/deposits/CircleDeposits.js";
import type { CursorStore, Rpc } from "../../adapters/deposits/BaseUsdcWatcher.js";
import type { CardIssuerPort, CardLifecyclePort } from "../interfaces/CardIssuing.js";
import type { PayoutRail } from "../../lib/interactors/PayoutInteractor.js";
import type { SwapConfig } from "../../lib/interactors/SwapInteractor.js";
import type { AgentWallets } from "../../lib/services/AgentWallets.js";
import type { Ledger } from "../../lib/services/Ledger.js";
import type { Tier, TierLimits } from "../../lib/services/tiers.js";
import type { FundingSource } from "../interfaces/FundingSource.js";

/** A chain the background workers poll for USDC deposits (the HD-wallet rail). */
export interface WatchedNetwork {
  /** Ledger chain label, e.g. "base-sepolia". */
  label: string;
  /** The USDC contract on that chain. */
  token: string;
  rpc: Rpc;
  cursor: CursorStore;
  confirmations: number;
}

/**
 * Everything `bootstrap.ts` builds from config: clients, repositories, adapters and settings. `createApp`
 * turns it into interactors; nothing below the composition root reads the environment.
 */
export interface AppParams {
  // ----- data -----
  /** The connection pool; only main.ts uses it, to close it on shutdown. */
  pool: pg.Pool;
  /** Drizzle handle over the pool. Interactors get repositories, not this (except for advisory locks). */
  db: Database;
  repos: Repositories;
  ledger: Ledger;
  addresses: DepositAddressRepository;

  // ----- card issuing (the provider chosen in bootstrap: Miden or the built-in mock) -----
  lifecycle: CardLifecyclePort;
  cards: CardIssuerPort;
  funding: FundingSource;
  tiers: Record<Tier, TierLimits>;
  /** Card details vault; without it cards issue but hosted checkouts cannot be paid. */
  vault?: CardVault;

  // ----- agents -----
  wallets: AgentWallets;

  // ----- deposits -----
  /** Ledger chain label for real deposits, e.g. "base-sepolia". */
  chain: string;
  /** The deposit address for a unique index (our HD wallet, or a Circle wallet). */
  deriveAddress: (index: number) => string | Promise<string>;
  depositNetworks?: string[];
  depositRail?: "circle" | "chain";
  /** Chains the background workers poll; empty when deposits arrive by Circle webhook. */
  watchedNetworks: WatchedNetwork[];
  circleDeposits?: CircleDeposits;

  // ----- checkouts, payouts, hosted-checkout swaps -----
  publicUrl: string;
  payoutAddressDelayMs: number;
  isOwnAddress: (address: string) => Promise<boolean>;
  payoutRail: PayoutRail;
  swapConfig: SwapConfig;
  checkoutFiller: CheckoutFiller;

  // ----- developers -----
  allowLocalWebhooks: boolean;

  // ----- environment -----
  /** Sandbox: agents pay through the provider's simulated authorization. */
  sandbox: boolean;
  simulatedDeposits: boolean;
  log: (msg: string) => void;
}
