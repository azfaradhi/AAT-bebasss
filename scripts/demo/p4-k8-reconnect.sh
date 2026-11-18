#!/usr/bin/env bash
# Kills the satellite connection N times against the fixture feed server and asserts contiguous offsets, no duplicates.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${FEED_FIXTURE_PORT:-18099}"
export FEED_URL="http://127.0.0.1:$PORT" KILLS="${KILLS:-25}"

PORT="$PORT" FRAMES_PER_SECOND="${FRAMES_PER_SECOND:-1000}" node "$ROOT/tools/feed-fixture-server/server.mjs" >/dev/null 2>&1 &
FEED_PID=$!
trap 'kill $FEED_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do curl -fs "$FEED_URL/admin/stats" >/dev/null 2>&1 && break; sleep 0.2; done

cd "$ROOT/services/satellite-processor"
npx tsx "$ROOT/scripts/demo/p4-k8-driver.ts"
