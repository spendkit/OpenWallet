// Composition root, part 1: reads the environment once and builds every client,
// repository and adapter into AppParams. Nothing below this file reads process.env.
import pg from "pg";
import { SealedCardVault, vaultKeyFromEnv } from "./adapters/cardVault/CardVault.js";
import { RoutingFiller } from "./adapters/checkoutFillers/RoutingFiller.js";
import { AdaptiveFiller } from "./adapters/checkoutFillers/AdaptiveFiller.js";
import { ClaudeFormPlanner } from "./adapters/checkoutFillers/FormPlanner.js";
import { BASE_SEPOLIA_USDC, ETHEREUM_SEPOLIA_USDC, jsonRpc } from "./adapters/deposits/BaseUsdcWatcher.js";
import { CircleDeposits } from "./adapters/deposits/CircleDeposits.js";
import { MockCardProvider } from "./adapters/providers/mock/MockCardProvider.js";
import { MidenWalletFunding } from "./adapters/funding/MidenWalletFunding.js";
import { UsdcPayoutRail } from "./adapters/payouts/UsdcPayoutRail.js";
import { CardLifecycle } from "./adapters/virtualCards/CardLifecycle.js";
import { CardService } from "./adapters/virtualCards/CardService.js";
import { HdDepositWallet } from "./adapters/wallet/HdDepositWallet.js";
import { createDatabase } from "./db/client.js";
import { migrate } from "./db/migrate.js";
import { createCursorStore, createDepositAddressRepository } from "./db/repositories/createChainRepositories.js";
import { createRepositories } from "./db/repositories/createRepositories.js";
import type { CardIssuerPort, CardLifecyclePort } from "./domain/interfaces/CardIssuing.js";
import type { FundingSource } from "./domain/interfaces/FundingSource.js";
import type { AppParams, WatchedNetwork } from "./domain/types/ContextTypes.js";
import { MidenClient } from "./lib/clients/cardIssuing/miden/MidenClient.js";
import { CircleClient } from "./lib/clients/circle/CircleClient.js";
import { swapConfigFromEnv } from "./lib/interactors/SwapInteractor.js";
import { AgentWallets } from "./lib/services/AgentWallets.js";
import { Ledger } from "./lib/services/Ledger.js";
import { DEFAULT_TIERS } from "./lib/services/tiers.js";

export interface ServerConfig {
  port: number;
  host: string;
  allowedHosts: string[];
  webhookOnlyHosts: string[];
  /** Shown in the startup line. */
  rpcHost: string;
}

export const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

export async function bootstrapApplication(env: NodeJS.ProcessEnv = process.env): Promise<{ params: AppParams; server: ServerConfig }> {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`Missing env var ${k}`);
    return v;
  };

  const PORT = Number(env.PORT ?? 8787);
  const HOST = env.HOST ?? "127.0.0.1";
  const publicUrl = env.PUBLIC_URL ?? `http://127.0.0.1:${PORT}`;
  // Card provider: CARD_PROVIDER=miden|mock. Unset means Miden when its credentials are present, else the in-memory mock,
  // so a fresh clone runs with no external accounts.
  const providerName = env.CARD_PROVIDER ?? (env.MIDEN_CLIENT_ID ? "miden" : "mock");
  if (providerName !== "miden" && providerName !== "mock") throw new Error(`CARD_PROVIDER must be "miden" or "mock", got "${providerName}"`);
  const baseUrl = env.MIDEN_BASE_URL ?? "https://sandbox-api.midencards.io/miden";
  // Sandbox-only: the mock always is; Miden only against its sandbox host.
  const sandbox = providerName === "mock" || new URL(baseUrl).host === "sandbox-api.midencards.io";
  if (!sandbox) throw new Error("this service is sandbox-only: MIDEN_BASE_URL must be the Miden sandbox");
  // Fake deposits only when asked for by name, and never against a non-sandbox provider.
  const simulatedDeposits = env.ALLOW_SIMULATED_DEPOSITS === "1";
  if (simulatedDeposits && !sandbox) throw new Error("ALLOW_SIMULATED_DEPOSITS=1 is only allowed in the sandbox");
  const chain: string = "base-sepolia";

  // ----- data -----
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL ?? "postgres://localhost/agent_cards", max: 10 });
  await migrate(pool);
  const db = createDatabase(pool);
  const repos = createRepositories(db);
  const ledger = new Ledger(undefined, repos.ledger);
  const addresses = createDepositAddressRepository(db, chain);

  // ----- card issuing -----
  // Card vault: card details are captured at issue time (a provider may give the PAN only once). Without
  // CARD_VAULT_KEY cards still issue, but their details are not kept and they can never pay hosted checkouts.
  const vault = env.CARD_VAULT_KEY ? new SealedCardVault(repos.vault, vaultKeyFromEnv(env)) : undefined;
  if (!vault) log("WARNING: CARD_VAULT_KEY is not set: card details are NOT captured at issue, and checkout swaps are off");
  let lifecycle: CardLifecyclePort;
  let cards: CardIssuerPort;
  let funding: FundingSource;
  if (providerName === "mock") {
    const mock = new MockCardProvider({ ...(vault ? { vault } : {}) });
    lifecycle = cards = funding = mock;
    log("card provider: mock (in-memory, no external account; state is lost on restart)");
  } else {
    const miden = new MidenClient({
      baseUrl,
      tokenUrl: env.MIDEN_TOKEN_URL ?? "https://sandbox-identityserver.midencards.io/connect/token",
      clientId: need("MIDEN_CLIENT_ID"),
      clientSecret: need("MIDEN_CLIENT_SECRET"),
      uniqueKey: need("MIDEN_UNIQUE_KEY"),
    });
    lifecycle = new CardLifecycle(miden);
    funding = new MidenWalletFunding(miden);
    cards = new CardService(miden, funding, undefined, vault
      ? { vault, keys: { clientId: need("MIDEN_CLIENT_ID"), uniqueKey: need("MIDEN_UNIQUE_KEY") }, log }
      : undefined);
    log("card provider: miden (sandbox)");
  }
  const wallets = new AgentWallets(ledger);
  const hd = HdDepositWallet.loadOrCreate(env.DEPOSIT_WALLET_FILE ?? ".sandbox-wallet.json");

  // ----- deposits -----
  // Circle deposit rail (sandbox): with CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET set, new cards get a Circle wallet
  // (created on the fly) and inbound USDC arrives by webhook at POST /webhooks/circle. Without them: our own HD wallet.
  if (!env.CIRCLE_API_KEY !== !env.CIRCLE_ENTITY_SECRET) throw new Error("set both CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET, or neither");
  const circle = env.CIRCLE_API_KEY && env.CIRCLE_ENTITY_SECRET
    ? new CircleClient({
        apiKey: env.CIRCLE_API_KEY, entitySecretHex: env.CIRCLE_ENTITY_SECRET,
        walletSetId: need("CIRCLE_WALLET_SET_ID"),
      })
    : undefined;
  if (circle && !env.CIRCLE_API_KEY!.startsWith("TEST_API_KEY:")) throw new Error("this service is sandbox-only: CIRCLE_API_KEY must be a Circle TEST_API_KEY");
  const circleDeposits = circle
    ? new CircleDeposits({
        circle, ledger, addresses, log,
        onCredited: (r) => log(`circle deposit: ${r.amountCents} cents on ${r.chain} for card ${r.cardId}`),
        onDust: (d) => log(`dust ${d.dustBase} base units on ${d.txHash} (not credited)`),
      })
    : undefined;
  if (circle) log("Circle deposits on: new deposit addresses are Circle wallets (BASE-SEPOLIA); webhook at /webhooks/circle");
  const circleOnly = circle !== undefined && env.CHAIN_WATCHER !== "1";

  // Chain watchers: Circle's test USDC on Base Sepolia, free public RPC. faucet.circle.com opens on Ethereum
  // Sepolia, so a user who misses the network picker pays there. One HD address is the same on every EVM
  // chain, so we watch both and credit with a chain label of its own. With Circle on, deposits come by
  // webhook; the pollers only matter for older HD addresses (CHAIN_WATCHER=1).
  const rpcUrl = env.BASE_RPC_URL ?? "https://base-sepolia-rpc.publicnode.com";
  const rpc = jsonRpc(rpcUrl);
  const allNetworks: WatchedNetwork[] = [
    { label: chain, token: BASE_SEPOLIA_USDC, rpc, cursor: createCursorStore(db, `${chain}:usdc`), confirmations: 5 },
    {
      label: "ethereum-sepolia", token: ETHEREUM_SEPOLIA_USDC, confirmations: 5,
      rpc: jsonRpc(env.ETHEREUM_SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com"),
      cursor: createCursorStore(db, "ethereum-sepolia:usdc"),
    },
  ];

  // ----- checkouts and payouts -----
  // Merchant payouts: USDC on Base Sepolia from our payout account (m/44'/60'/1'/0/0). Fund it with test USDC
  // (faucet.circle.com, Base Sepolia) and a little Base Sepolia ETH for gas.
  const payoutAccount = hd.payoutAccount();
  const payoutRail = new UsdcPayoutRail({ rpc, account: payoutAccount, confirmations: 5 });

  // ----- hosted-checkout swaps: agents pay third-party hosted checkouts (Stripe) with the vaulted card. Off unless SWAP_ENABLED=1.
  const swapConfig = swapConfigFromEnv(env);
  if (swapConfig.testHosts?.length && !swapConfig.stripeTestCard) throw new Error("SWAP_TEST_HOSTS needs SWAP_STRIPE_TEST_CARD=1 (sandbox only)");
  // Unfamiliar checkout forms: read from their labels; with a key, a model maps the ones whose labels are not enough.
  const aiPlanner = env.SWAP_AI_FILL !== "0" && env.ANTHROPIC_API_KEY ? new ClaudeFormPlanner(env.SWAP_AI_MODEL ? { model: env.SWAP_AI_MODEL } : {}) : undefined;
  const adaptiveFiller = new AdaptiveFiller({ ...(aiPlanner ? { planner: aiPlanner } : {}), log });
  if (swapConfig.stripeTestCard && !sandbox) throw new Error("SWAP_STRIPE_TEST_CARD=1 is only allowed in the sandbox");
  if (swapConfig.enabled && !vault) throw new Error("SWAP_ENABLED=1 needs CARD_VAULT_KEY");
  if (swapConfig.enabled && vault) {
    log(`checkout swap on: hosts ${swapConfig.allowedHosts.join(", ")}, cap $${(swapConfig.maxAmountCents / 100).toFixed(2)}`);
    if (swapConfig.stripeTestCard) log("checkout swap: SWAP_STRIPE_TEST_CARD=1, Stripe TEST-mode links are paid with Stripe's 4242 test card (sandbox only)");
    if (swapConfig.testHosts?.length) log(`checkout swap: test shops paid with the 4242 test card: ${swapConfig.testHosts.join(", ")}`);
    if (swapConfig.openHosts) log(`checkout swap: SWAP_OPEN_HOSTS=1, other public https checkouts are paid with a one-time card only; unfamiliar forms ${aiPlanner ? "are mapped from their labels, then by a model" : "are paid only when their labels are clear (no ANTHROPIC_API_KEY)"}`);
  }
  log(`payout account (Base Sepolia, fund with test USDC + ETH): ${payoutAccount.address}`);

  const params: AppParams = {
    pool, db, repos, ledger, addresses,
    lifecycle, cards, funding, tiers: DEFAULT_TIERS, vault,
    wallets,
    chain,
    deriveAddress: circle ? async (i) => (await circle.createDepositWallet(i)).address : (i) => hd.address(i),
    ...(circleOnly ? { depositNetworks: [chain], depositRail: "circle" as const } : {}),
    watchedNetworks: circleOnly ? [] : allNetworks,
    circleDeposits,
    publicUrl,
    // Sandbox default 10 minutes so a demo can pay out the same day; the code default (and production) is 24 h.
    payoutAddressDelayMs: Number(env.PAYOUT_ADDRESS_DELAY_S ?? 600) * 1000,
    isOwnAddress: async (a) => a === payoutAccount.address.toLowerCase() || (await addresses.cardFor(a)) !== undefined,
    payoutRail,
    swapConfig,
    // The adaptive filler only ever sees pages SwapInteractor let through: open hosts or test shops, on a one-time or test card.
    checkoutFiller: swapConfig.openHosts || swapConfig.testHosts?.length ? RoutingFiller.withAdaptive(adaptiveFiller) : new RoutingFiller(),
    // Sandbox: developers may point webhooks at http://localhost. Real deployments (not sandbox) never do.
    allowLocalWebhooks: sandbox,
    sandbox,
    simulatedDeposits,
    log,
  };

  return {
    params,
    server: {
      port: PORT,
      host: HOST,
      allowedHosts: [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`, ...(env.ALLOWED_HOSTS ? env.ALLOWED_HOSTS.split(",") : [])],
      webhookOnlyHosts: env.WEBHOOK_ONLY_HOSTS ? env.WEBHOOK_ONLY_HOSTS.split(",") : [],
      rpcHost: new URL(rpcUrl).host,
    },
  };
}
