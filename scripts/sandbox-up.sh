#!/bin/sh
# Starts the service in the background on http://127.0.0.1:8787 (override with PORT).
#
# No accounts needed: with no MIDEN_* set it uses the in-memory mock card provider.
# Set MIDEN_CLIENT_ID, MIDEN_CLIENT_SECRET and MIDEN_UNIQUE_KEY to use the Miden sandbox instead.
#
# Postgres, first match wins:
#   1. DATABASE_URL already set in the environment (any Postgres you run)
#   2. Docker:   docker compose up -d   (docker-compose.yml, localhost:5432)
#   3. Homebrew: brew services start postgresql@16
#
# Simulated deposits are on here (ALLOW_SIMULATED_DEPOSITS=0 to turn them off).
# Stop with scripts/sandbox-down.sh. Log: .run/server.log
set -e
cd "$(dirname "$0")/.."
PORT="${PORT:-8787}"

if [ ! -d node_modules ]; then
  echo "dependencies are not installed: run 'pnpm install' first" >&2; exit 1
fi

if [ -n "${DATABASE_URL:-}" ]; then
  echo "using DATABASE_URL"
elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  docker compose up -d --wait postgres >/dev/null
  export DATABASE_URL="postgres://postgres:postgres@127.0.0.1:5432/agent_cards"
  echo "postgres: docker compose"
elif command -v brew >/dev/null 2>&1 && brew list postgresql@16 >/dev/null 2>&1; then
  brew services start postgresql@16 >/dev/null
  export PATH="$(brew --prefix postgresql@16)/bin:$PATH"
  until pg_isready -q; do sleep 1; done
  psql -lqt | cut -d'|' -f1 | grep -qw agent_cards || createdb agent_cards
  export DATABASE_URL="postgres://localhost/agent_cards"
  echo "postgres: homebrew postgresql@16"
else
  cat >&2 <<'EOF'
No Postgres found. Do one of:
  - start Docker, then re-run this script
  - install Postgres 16 (brew install postgresql@16) and re-run
  - export DATABASE_URL=postgres://user:pass@host:5432/dbname
EOF
  exit 1
fi

if [ -z "${CARD_PROVIDER:-}" ] && [ -z "${MIDEN_CLIENT_ID:-}" ]; then
  echo "card provider: mock (in memory; set MIDEN_* to use the Miden sandbox)"
fi

mkdir -p .run
if [ -f .run/server.pid ] && kill -0 "$(cat .run/server.pid)" 2>/dev/null; then
  echo "already running (pid $(cat .run/server.pid)) at http://127.0.0.1:$PORT"; exit 0
fi
PORT="$PORT" ALLOW_SIMULATED_DEPOSITS="${ALLOW_SIMULATED_DEPOSITS:-1}" nohup node --import tsx src/main.ts >> .run/server.log 2>&1 &
echo $! > .run/server.pid

i=0
until curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 30 ] || ! kill -0 "$(cat .run/server.pid)" 2>/dev/null; then
    echo "the service did not come up; last log lines:" >&2
    tail -n 15 .run/server.log >&2
    exit 1
  fi
  sleep 1
done
echo "running (pid $(cat .run/server.pid)) at http://127.0.0.1:$PORT; log: .run/server.log"
