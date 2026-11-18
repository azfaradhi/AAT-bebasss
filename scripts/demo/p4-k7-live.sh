#!/usr/bin/env bash
# Runs the satellite pipeline on the REAL live feed for DURATION_S (default 330 s) using the group token from .env.local
# (never printed). Open the lag/late panels on screen while it runs. One connection only: do not run it while another consumer is connected.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/services/satellite-processor"
ENV_FILE="${ENV_FILE:-$ROOT/.env.local}" OUT_DIR="${OUT_DIR:-/tmp/p4-live}" npx tsx "$ROOT/scripts/demo/p4-live-driver.ts" live
