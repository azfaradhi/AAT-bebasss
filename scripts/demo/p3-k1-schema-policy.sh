#!/usr/bin/env bash
# Runs every schema-change mode against the PVMBG mock and compares the aggregator mapping with the declared policy.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${PVMBG_DEMO_PORT:-18082}"
export PVMBG_JWT_SECRET="${PVMBG_JWT_SECRET:-demo-secret}" PVMBG_PORT="$PORT" PVMBG_URL="http://127.0.0.1:$PORT"
export PVMBG_DELAY_MIN_MS=0 PVMBG_DELAY_MAX_MS=0 PVMBG_LIVE_INTERVAL_MS=200

cd "$ROOT/services/pvmbg-mock"
npx tsx src/index.ts >/dev/null 2>&1 &
MOCK_PID=$!
trap 'kill $MOCK_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do curl -fs "$PVMBG_URL/ready" >/dev/null 2>&1 && break; sleep 0.2; done

cd "$ROOT/services/aggregator"
npx tsx "$ROOT/scripts/demo/p3-k1-driver.ts"
