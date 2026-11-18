#!/usr/bin/env bash
# update keeps the hazard_id and changes attributes; a retract below 2 detections removes the event; re-detection revives it.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/services/satellite-processor"
npx tsx "$ROOT/scripts/demo/p4-fire-driver.ts" k3
