#!/usr/bin/env bash
# Feeds hostile PVMBG responses through the guarded fetch -> map -> park path and asserts nothing crashes.
# In a cluster (AGGREGATOR_NAMESPACE set and kubectl available) it also asserts aggregator restartCount == 0.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${PVMBG_DEMO_PORT:-18082}"
export PVMBG_JWT_SECRET="${PVMBG_JWT_SECRET:-demo-secret}" PVMBG_PORT="$PORT" PVMBG_URL="http://127.0.0.1:$PORT"
export PVMBG_DELAY_MIN_MS=0 PVMBG_DELAY_MAX_MS=0

restarts() {
  kubectl -n "$AGGREGATOR_NAMESPACE" get pod -l app=aggregator -o jsonpath='{range .items[*]}{.metadata.name}={.status.containerStatuses[0].restartCount}{"\n"}{end}'
}

if [[ -n "${AGGREGATOR_NAMESPACE:-}" ]] && command -v kubectl >/dev/null; then
  echo "cluster restartCount before:"; restarts
fi

if curl -fs "$PVMBG_URL/ready" >/dev/null 2>&1; then echo "port $PORT is already in use by another mock; stop it first" >&2; exit 3; fi
cd "$ROOT/services/pvmbg-mock"
npx tsx src/index.ts >/dev/null 2>&1 &
MOCK_PID=$!
kill_tree() { for c in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$c"; done; kill "$1" 2>/dev/null || true; }
trap 'kill_tree $MOCK_PID' EXIT
for _ in $(seq 1 50); do curl -fs "$PVMBG_URL/ready" >/dev/null 2>&1 && break; sleep 0.2; done

cd "$ROOT/services/aggregator"
npx tsx "$ROOT/scripts/demo/p3-k3-driver.ts"

if [[ -n "${AGGREGATOR_NAMESPACE:-}" ]] && command -v kubectl >/dev/null; then
  echo "cluster restartCount after:"; AFTER="$(restarts)"; echo "$AFTER"
  if grep -qv '=0$' <<<"$AFTER"; then echo "FAIL: aggregator restarted"; exit 1; fi
else
  echo "NOTE: restartCount check skipped (no AGGREGATOR_NAMESPACE/kubectl); this run proves the in-process path only"
fi
