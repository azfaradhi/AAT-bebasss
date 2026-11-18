#!/usr/bin/env bash
# Drill on the REAL feed: our own connection is cut every FORCE_DISCONNECT_EVERY_S seconds (a stand-in for the temporary
# egress block of the cluster drill; set KUBE=1 for that, not implemented yet). Offsets must stay contiguous, nothing duplicated.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if [[ "${KUBE:-}" == "1" ]]; then echo "cluster egress-block mode is not implemented yet: services are not deployed"; exit 2; fi
cd "$ROOT/services/satellite-processor"
ENV_FILE="${ENV_FILE:-$ROOT/.env.local}" OUT_DIR="${OUT_DIR:-/tmp/p4-disconnect}" DURATION_S="${DURATION_S:-150}" npx tsx "$ROOT/scripts/demo/p4-live-driver.ts" disconnect
