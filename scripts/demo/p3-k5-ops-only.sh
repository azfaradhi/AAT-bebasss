#!/usr/bin/env bash
# /ops/unprocessed is Internal-only (media/lapangan -> 403); the audit endpoint lists retrying and parked with the audit token.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/services/aggregator"
npx tsx "$ROOT/scripts/demo/p3-k5-driver.ts"
