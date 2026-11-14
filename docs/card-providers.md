# Card providers

The core never talks to a card issuer directly. It depends on the ports in `src/domain/interfaces/CardIssuing.ts`:

| Port | What it covers |
| --- | --- |
| `CardLifecyclePort` | Submit and read KYC, card balance, card transactions, simulated purchases (sandbox) |
| `CardIssuerPort` | Issue a card, issue a one-time card, capture card details into the vault, top up, per-day spend checks |
| `FundingSource` (`domain/interfaces/FundingSource.ts`) | Move money onto a card |

Failures use the neutral classes in `src/domain/errors/CardProviderErrors.ts` (`CardProviderApiError`, `CardProviderBusinessError`, `DuplicateReferenceError`, `isDefiniteRefusal`). A provider's own errors extend these, so the interactors never import a provider.

## Choosing one

`CARD_PROVIDER=mock|miden`. Left unset, it is `miden` when `MIDEN_CLIENT_ID` is set and `mock` otherwise, so a fresh clone runs with no accounts. The choice is made once, in `src/bootstrap.ts`.

| Provider | Where | Notes |
| --- | --- | --- |
| `mock` | `src/adapters/providers/mock/MockCardProvider.ts` | In memory. KYC is approved at once, cards use the Visa test number, simulated purchases and top-ups move a balance. State is lost on restart. Sandbox only. |
| `miden` | `CardService`, `CardLifecycle`, `MidenWalletFunding`, `src/lib/clients/cardIssuing/miden/` | The [Miden Workspace API](miden-api.md), sandbox only. Needs `MIDEN_CLIENT_ID`, `MIDEN_CLIENT_SECRET`, `MIDEN_UNIQUE_KEY`. |

## Adding a provider

1. Implement `CardLifecyclePort`, `CardIssuerPort` and `FundingSource` (`MockCardProvider` is the smallest worked example; reuse `SpendTracker` for `authorize`).
2. Throw the neutral error classes: a 4xx other than 429 is a definite refusal, anything else may have gone through and is retried with the same key.
3. Derive any provider-specific idempotency header from the key the core passes (`idempotencyKey`); do not expect the core to know the format.
4. Add a branch in `bootstrap.ts`, and keep it sandbox-only until the gaps in [production-gaps.md](production-gaps.md) are closed.

Still Miden-shaped, to be generalised when a second real provider needs it: the `miden_auth_id` column on `app_spend`, and the Miden-specific scripts in `scripts/`.
