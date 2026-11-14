# Changelog

All notable changes. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are not published yet.

## Unreleased

### Added
- Mock card provider: the service runs with no external accounts (`CARD_PROVIDER=mock`, the default when no `MIDEN_*` is set).
- `pnpm dev:up`, `pnpm dev:down`, `pnpm dev:keys`: one-command local start (Docker, Homebrew or your own Postgres), then sandbox keys and a paid test checkout.
- Circle deposit rail, low-balance and stuck-funding alerts, production start-up guards, `scripts/circle-reconcile.ts`.
- [docs/configuration.md](docs/configuration.md): every environment variable.

### Changed
- `scripts/sandbox-up.sh` no longer requires Miden credentials or Homebrew.
- Card issuing sits behind provider-neutral ports; Miden is one provider.
