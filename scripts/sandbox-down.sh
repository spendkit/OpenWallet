#!/bin/sh
# Stops the service started by scripts/sandbox-up.sh. Leaves Postgres running (docker compose down to stop it).
cd "$(dirname "$0")/.."
if [ -f .run/server.pid ] && kill -0 "$(cat .run/server.pid)" 2>/dev/null; then
  kill "$(cat .run/server.pid)" && echo "stopped pid $(cat .run/server.pid)"
else
  echo "not running"
fi
rm -f .run/server.pid
