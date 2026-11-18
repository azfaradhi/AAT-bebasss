#!/usr/bin/env bash
# Compares the streaming pipeline's final events with an independent batch computation over the same stream
# (the assistants' reference is not available, see ASSUMPTIONS Q10). LATENESS_MIN=60 shows how a tighter bound creates explained differences.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${FEED_FIXTURE_PORT:-18102}"
export FEED_URL="http://127.0.0.1:$PORT"

PORT="$PORT" REPEAT_CYCLES="${REPEAT_CYCLES:-3}" node --max-old-space-size=2048 "$ROOT/tools/feed-fixture-server/server.mjs" >/dev/null 2>&1 &
FEED_PID=$!
trap 'kill $FEED_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 100); do curl -fs "$FEED_URL/admin/info" >/dev/null 2>&1 && break; sleep 0.2; done

cd "$ROOT/services/satellite-processor"
npx tsx "$ROOT/scripts/demo/p4-k6-driver.ts"
