#!/usr/bin/env bash
# Starts the components owned by Member 1 locally and checks that /metrics exposes the contract metric names
# and that log lines carry the contract fields. Stand-in for the platform checks until the obs-kit exists.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PIDS=(); LOGS="$(mktemp -d)"
kill_tree() { local p="$1"; for c in $(pgrep -P "$p" 2>/dev/null); do kill_tree "$c"; done; kill "$p" 2>/dev/null || true; }
cleanup() { for p in "${PIDS[@]}"; do kill_tree "$p"; done; rm -rf "$LOGS"; }
trap cleanup EXIT
FAIL=0
check() { if grep -q -- "$2" <<<"$3"; then echo "PASS  $1: $2"; else echo "FAIL  $1: $2"; FAIL=1; fi; }
launch() { # launch <name> <dir> <cmd...> with env already exported by the caller via env
  local name="$1" dir="$2"; shift 2
  ( cd "$ROOT/$dir" && exec env "$@" ) >"$LOGS/$name.log" 2>&1 &
  PIDS+=($!)
}
wait_ready() { for _ in $(seq 1 40); do curl -fs "localhost:$1/ready" >/dev/null 2>&1 && return 0; sleep 0.5; done; echo "FAIL  port $1 never became ready"; FAIL=1; }

launch feed tools/feed-fixture-server PORT=18099 FRAMES_PER_SECOND=2000 node server.mjs
launch pvmbg services/pvmbg-mock PVMBG_PORT=18082 PVMBG_JWT_SECRET=s PVMBG_DELAY_MIN_MS=0 PVMBG_DELAY_MAX_MS=0 npx tsx src/index.ts
launch bmkg services/bmkg-mock BMKG_PORT=18081 BMKG_API_KEY=k BMKG_DELAY_MIN_MS=0 BMKG_DELAY_MAX_MS=0 npx tsx src/index.ts
launch satellite-processor services/satellite-processor SAT_FEED_BASE_URL=http://127.0.0.1:18099 SAT_GROUP_TOKEN=x SATELLITE_PORT=18095 POD_NAME=sat-test NODE_NAME=node-test npx tsx src/index.ts
launch frp services/field-report-processor FIELD_REPORT_PORT=18096 POD_NAME=frp-test npx tsx src/index.ts
for port in 18082 18081 18095 18096; do wait_ready "$port"; done
sleep 2
for port in 18082 18081 18095 18096; do curl -s -o /dev/null "localhost:$port/health"; done

RED=bnpb_http_server_request_duration_seconds
M="$(curl -s localhost:18082/metrics)";  check pvmbg-mock "$RED" "$M"; check pvmbg-mock 'status_class="2xx"' "$M"
M="$(curl -s localhost:18081/metrics)";  check bmkg-mock "$RED" "$M"
M="$(curl -s localhost:18095/metrics)"
for name in "$RED" bnpb_sat_offset_lag bnpb_sat_late_applied_total bnpb_sat_late_beyond_bound_total bnpb_sat_event_to_store_seconds_bucket bnpb_ingest_events_total bnpb_parked_messages; do check satellite-processor "$name" "$M"; done
M="$(curl -s localhost:18096/metrics)"; check field-report-processor "$RED" "$M"; check field-report-processor bnpb_field_reports_total "$M"
S="$(curl -s localhost:18095/internal/satellite/stats)"; check satellite-processor 'open_fires' "$S"

LINE="$(grep -h '"level"' "$LOGS"/satellite-processor.log | head -1)"
if [[ -z "$LINE" ]]; then echo "FAIL  satellite-processor: no JSON log line captured"; FAIL=1; else
  for f in '"ts"' '"level"' '"service":"satellite-processor"' '"instance":"sat-test"' '"node":"node-test"'; do check satellite-log "$f" "$LINE"; done; fi
[[ $FAIL == 0 ]] && echo -e "\nPASS: contract metric names and log fields present" || echo -e "\nFAIL"
exit $FAIL
