#!/usr/bin/env bash
# One fire seen by several satellites -> exactly one HazardEvent (synthetic pair + the real captured slice).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/services/satellite-processor"
npx tsx "$ROOT/scripts/demo/p4-fire-driver.ts" k1
