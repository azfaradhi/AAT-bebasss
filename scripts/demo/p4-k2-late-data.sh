#!/usr/bin/env bash
# Replays controlled late detections (on both sides of the 360 min bound) through the fixture feed server.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${FEED_FIXTURE_PORT:-18098}"
TMP="$(mktemp -d)"
export FEED_URL="http://127.0.0.1:$PORT"

cd "$ROOT/services/satellite-processor"
npx tsx "$ROOT/scripts/demo/p4-k2-driver.ts" gen > "$TMP/frames.jsonl"
PORT="$PORT" FRAMES_FILE="$TMP/frames.jsonl" node "$ROOT/tools/feed-fixture-server/server.mjs" >/dev/null 2>&1 &
FEED_PID=$!
trap 'kill $FEED_PID 2>/dev/null || true; rm -rf "$TMP"' EXIT
for _ in $(seq 1 50); do curl -fs "$FEED_URL/admin/stats" >/dev/null 2>&1 && break; sleep 0.2; done
npx tsx "$ROOT/scripts/demo/p4-k2-driver.ts" run
