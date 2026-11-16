#!/usr/bin/env bash
# Runs every schema-change mode against the PVMBG mock and compares the aggregator mapping with the declared policy.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${PVMBG_DEMO_PORT:-18082}"
export PVMBG_JWT_SECRET="${PVMBG_JWT_SECRET:-demo-secret}" PVMBG_PORT="$PORT" PVMBG_URL="http://127.0.0.1:$PORT"
export PVMBG_DELAY_MIN_MS=0 PVMBG_DELAY_MAX_MS=0 PVMBG_LIVE_INTERVAL_MS=200

if curl -fs "$PVMBG_URL/ready" >/dev/null 2>&1; then echo "port $PORT is already in use by another mock; stop it first" >&2; exit 3; fi
cd "$ROOT/services/pvmbg-mock"
npx tsx src/index.ts >/dev/null 2>&1 &
MOCK_PID=$!
kill_tree() { for c in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$c"; done; kill "$1" 2>/dev/null || true; }
trap 'kill_tree $MOCK_PID' EXIT
for _ in $(seq 1 50); do curl -fs "$PVMBG_URL/ready" >/dev/null 2>&1 && break; sleep 0.2; done

cd "$ROOT/services/aggregator"
npx tsx "$ROOT/scripts/demo/p3-k1-driver.ts"
