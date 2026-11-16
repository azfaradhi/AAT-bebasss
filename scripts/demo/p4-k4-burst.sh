#!/usr/bin/env bash
# Replays a ~108k-frame burst (the size of the real backlog) through the fixture feed at FPS frames/s, measures lag over time,
# catch-up time after the burst ends, event-to-store p95, memory and loss. WRITE_LATENCY_MS models a replicated ring write.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${FEED_FIXTURE_PORT:-18101}"
export FEED_URL="http://127.0.0.1:$PORT"
FPS="${FPS:-3000}"   # real backlog drained at ~2 800 frames/s; live head produces ~9 frames/s at 60x

PORT="$PORT" FRAMES_PER_SECOND="$FPS" REPEAT_CYCLES="${REPEAT_CYCLES:-36}" node --max-old-space-size=2048 "$ROOT/tools/feed-fixture-server/server.mjs" >/dev/null 2>&1 &
FEED_PID=$!
trap 'kill $FEED_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 100); do curl -fs "$FEED_URL/admin/info" >/dev/null 2>&1 && break; sleep 0.2; done

cd "$ROOT/services/satellite-processor"
npx tsx "$ROOT/scripts/demo/p4-k4-driver.ts"
