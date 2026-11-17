#!/usr/bin/env bash
# Demo Script P5-K8 / MB3-T14: SLI, SLO & Error Budget Burn Rate Inspection
set -euo pipefail

PROM_URL="${PROM_URL:-http://localhost:9090}"

echo "=== [P5-K8] Querying Prometheus SLI/SLO Recording Rules ==="
for rule in \
  "sli:client_api_availability:ratio_rate5m" \
  "sli:client_api_latency_p99:seconds_5m" \
  "slo:client_api_error_budget_remaining:ratio" \
  "slo:client_api_burn_rate:5m" \
  "sli:critical_alert_e2e_p95:seconds_5m" \
  "sli:storage_units_healthy:count"; do
  echo "--- Rule: ${rule} ---"
  curl -sSf --get "${PROM_URL}/api/v1/query" --data-urlencode "query=${rule}" || true
  echo ""
done
