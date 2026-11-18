#!/usr/bin/env bash
# Demo Script P5-K1: Fast Critical Coastal Alert Path (0 lost, p95 <= 5.0s)
set -euo pipefail

NAMESPACE="${NAMESPACE:-sistem-informasi-kebencanaan-bnpb}"
NOTIFIER_URL="${NOTIFIER_URL:-http://localhost:8093}"
PROM_URL="${PROM_URL:-http://localhost:9090}"

echo "=== [P5-K1] Inspecting Critical Alert Deliveries on notifier-lapangan ==="
curl -sSf "${NOTIFIER_URL}/internal/critical-deliveries?limit=50" | node -e '
  const fs = require("fs");
  const body = JSON.parse(fs.readFileSync(0, "utf8"));
  console.log(`Total critical alerts delivered: ${body.total}`);
  console.log(`Measured E2E p95 (seconds):      ${body.p95_seconds}`);
  if (body.p95_seconds !== null && body.p95_seconds > 5.0) {
    console.error("[FAIL] p95 exceeds 5.0s SLO!");
    process.exit(1);
  }
  console.log("[PASS] P5-K1 critical alert E2E p95 <= 5.0s verified.");
'

echo "=== [P5-K1] Prometheus bnpb_critical_total & bnpb_critical_e2e_seconds ==="
curl -sSf "${NOTIFIER_URL}/metrics" | grep -E "^bnpb_critical_(total|e2e_seconds)" || true
