#!/usr/bin/env bash
# Runs the satellite pipeline over the fixture feed twice: fault-free, and killed at random points (mid-batch, mid-merge,
# between the event writes and the cursor commit); the final events must be byte-identical (ingested_at ignored).
# In-process kill simulation: a dead process loses its memory and can write nothing more. For `kubectl delete pod --grace-period=0` set KUBE=1 (not implemented until the services are deployed).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${FEED_FIXTURE_PORT:-18097}"
export FEED_URL="http://127.0.0.1:$PORT"
if [[ "${KUBE:-}" == "1" ]]; then echo "cluster mode is not implemented yet: services are not deployed (see handoffs)"; exit 2; fi

PORT="$PORT" node "$ROOT/tools/feed-fixture-server/server.mjs" >/dev/null 2>&1 &
FEED_PID=$!
trap 'kill $FEED_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do curl -fs "$FEED_URL/admin/stats" >/dev/null 2>&1 && break; sleep 0.2; done

cd "$ROOT/services/satellite-processor"
npx tsx "$ROOT/scripts/demo/p4-k5-driver.ts"
