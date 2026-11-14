# Wallet setup for the sandbox demo (our own wallets)

For the demo we do not use a custody provider. We generate and hold our own deposit wallet, and every user's deposit address comes from it. Code: `src/adapters/wallet/HdDepositWallet.ts`; address allocation in `src/lib/interactors/CardholderInteractor.ts` (`ensureDepositAddress`). **Sandbox and testnet only.**

There are three different "wallets" in this project. Keep them apart:

| Wallet | What it is | Where it lives | Who controls it |
| --- | --- | --- | --- |
| **Deposit wallet** (this doc) | On-chain EVM addresses on Base Sepolia that receive test USDC | A BIP-39 mnemonic in a local file | Us |
| **Miden USD wallet** | The Miden account balance that pays card top-ups | Miden | Miden; pre-funded in the sandbox |
| **Agent wallets** | Ledger sub-balances with spend policies | Postgres ledger accounts `agent:<card>:<agent>` | The owner, via the app |

The agent wallets are not blockchain wallets: see [sandbox-flow.md](sandbox-flow.md) and [finance-data.md](finance-data.md).

## The deposit wallet

`HdDepositWallet` holds one BIP-39 mnemonic (generated with `viem`'s `generateMnemonic(english)`) and derives one address per card at the standard Ethereum path `m/44'/60'/0'/0/<index>`. The same address works on every EVM chain, but the watcher only watches the chain it is configured for (Base Sepolia here).

- **File:** `DEPOSIT_WALLET_FILE`, default `.sandbox-wallet.json` in the working directory. Shape: `{ "note": "TESTNET ONLY…", "mnemonic": "twelve words …" }`.
- **First boot creates it** if the file does not exist, with mode `0600`. On every load it re-applies `chmod 600` and **throws if the file is readable by group or others**, or if it holds no mnemonic of 12+ words.
- **Git-ignored** (`.sandbox-wallet.json` is in `.gitignore`), as are `.env*`, `.sandbox-state.json` and `.run`. Never commit it, paste it into chat, or copy it into another file. Anyone with the mnemonic controls every address, including any funds on them.
- `address(index)` accepts integers from 0 to 2³¹−1 and returns the lower-case address.

Do not read or print the file in demos, logs or tickets. If you need to prove an address is ours, derive it with the code and compare addresses only.

### How a user gets an address

1. The user's KYC is approved and their card is issued.
2. `ensureDepositAddress(cardId)` takes the next number from the Postgres sequence `deposit_derivation_seq` (starts at 0), derives the address at that index, stores it in `deposit_address` with `card_id`, and records `derivation_index` (unique).
3. It is idempotent: a card with an address already gets the same one back.
4. The address is added to the watcher's book *before* it is shown to the user, so no deposit can arrive unwatched. The dashboard shows it as "USDC on base-sepolia".

`derivation_index` is what makes recovery possible: with the mnemonic and the index the private key can be re-derived. **Keep the mnemonic file and the database together in any backup, or addresses are orphaned**: losing the file means losing access to anything sent to those addresses.

## Setting up the demo, step by step

1. **Postgres.** Create a database and point at it: `createdb agent_cards` and `export DATABASE_URL=postgres://localhost/agent_cards` (this is also the default). Migrations apply themselves on boot.
2. **Miden credentials** are environment variables (`MIDEN_CLIENT_ID`, `MIDEN_CLIENT_SECRET`, `MIDEN_UNIQUE_KEY`), only needed for the Miden provider. If a tool needs a `.env`, create it yourself and keep it out of git. This machine's IP must be whitelisted in the Miden dashboard or calls return 401/403.
3. **Start the service:** `node --import tsx src/main.ts`. First boot creates the wallet file. Check the log line `agent-cards sandbox on http://127.0.0.1:8787 (chain base-sepolia, rpc …)`.
4. **Sign up and KYC** in the dashboard (`http://127.0.0.1:8787`) with dummy data. For the sandbox, `idType: PASSPORT`, a distinct id number/phone/email per demo user (identity de-duplication), and any small PNG/JPEG as the ID image.
5. **Copy the deposit address** from the dashboard once the card shows.
6. **Get test USDC:** use Circle's faucet (faucet.circle.com), choose **Base Sepolia**, USDC, and paste the address. The faucet is rate-limited. You do not need test ETH to *receive*: the sender pays gas, not us.
7. **Wait.** The watcher credits after 5 confirmations and the funder moves it to the card within about 5 s after that. The overview shows `awaitingFundingCents` → `unallocatedOnCardCents`, and the card balance on Miden rises.
8. **No faucet handy?** Use the dashboard's "simulate deposit" (`POST /api/me/simulate-deposit`, max $1,000). It goes through the same ledger path, labelled `simulated`, so the rest of the demo is identical. Say so when presenting it.

Funds under $1 wait for more deposits; funds beyond the tier's lifetime cap (quick: $500, placeholder) stay in holding.

## What is deliberately missing (do not demo these as done)

- **No sweeping.** Nothing moves USDC from user deposit addresses to a treasury address. Test USDC just sits there.
- **No production custody.** A mnemonic in a file on a laptop is acceptable for testnet only. Production needs an HSM/KMS or a custody provider, key rotation, and an access policy. Get a security review before it is used for anything real.
- **No real mainnet flow.** The service refuses non-sandbox Miden URLs; the watcher has a mainnet USDC constant but nothing in `main.ts` enables it.
- **No withdrawals.** Users cannot send USDC out.
- **Address gap/limit handling:** every card gets exactly one address; there is no address reuse policy, expiry or per-user rotation.

## Quick checks

- Is my address derived from this wallet? `SELECT address, derivation_index FROM deposit_address ORDER BY derivation_index;` then compare with `hd.address(index)` in a throwaway script (addresses only; never print the mnemonic).
- File permissions: `ls -l .sandbox-wallet.json` should show `-rw-------`.
- Watcher is seeing the address: it appears in `SELECT address FROM deposit_address WHERE chain = 'base-sepolia'`.
