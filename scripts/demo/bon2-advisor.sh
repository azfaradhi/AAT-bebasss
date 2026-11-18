#!/usr/bin/env bash
# BON-2: the same stream is processed with and without the advisor beside it, while a fake LLM is made slow, dead and
# wrong. The alert path (events) must come out identical; the advisor must absorb every LLM failure.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FEED_PORT="${FEED_FIXTURE_PORT:-18104}"; LLM_PORT="${FAKE_LLM_PORT:-18105}"
export FEED_URL="http://127.0.0.1:$FEED_PORT" FAKE_LLM_URL="http://127.0.0.1:$LLM_PORT"
for p in "$FEED_PORT" "$LLM_PORT"; do if lsof -i ":$p" >/dev/null 2>&1; then echo "port $p already in use" >&2; exit 3; fi; done

PORT="$FEED_PORT" REPEAT_CYCLES="${REPEAT_CYCLES:-3}" node "$ROOT/tools/feed-fixture-server/server.mjs" >/dev/null 2>&1 &
P1=$!
PORT="$LLM_PORT" node "$ROOT/tools/fake-llm/server.mjs" >/dev/null 2>&1 &
P2=$!
trap 'kill $P1 $P2 2>/dev/null || true' EXIT
for _ in $(seq 1 100); do curl -fs "$FEED_URL/admin/info" >/dev/null 2>&1 && curl -fs "$FAKE_LLM_URL/admin/stats" >/dev/null 2>&1 && break; sleep 0.2; done

cd "$ROOT/services/advisor"
npx tsx "$ROOT/scripts/demo/bon2-driver.ts"
