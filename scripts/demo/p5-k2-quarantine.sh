#!/usr/bin/env bash
# Demo Script P5-K2: Behavior-Based Sensor Validation & Quarantine (CONTRACT_VIOLATION)
set -euo pipefail

AGGREGATOR_URL="${AGGREGATOR_URL:-http://localhost:8090}"
AUDIT_TOKEN="${AUDIT_TOKEN:-dev-audit-token-bnpb-m2}"

echo "=== [P5-K2] 1/2 Canonical COASTAL Events (Valid Observations Only) ==="
curl -sSf -H "Authorization: Bearer ${AUDIT_TOKEN}" \
  "${AGGREGATOR_URL}/internal/audit/events?source=SENSOR_PANTAI&limit=20" | node -e '
  const fs = require("fs");
  const body = JSON.parse(fs.readFileSync(0, "utf8"));
  console.log(`Valid SENSOR_PANTAI events in canonical storage: ${(body.items || []).length}`);
  for (const ev of (body.items || []).slice(0, 5)) {
    console.log(`  - ${ev.hazard_id} (${ev.source_ref_id}): severity=${ev.severity}, area=${ev.area_name}`);
  }
'

echo "=== [P5-K2] 2/2 Quarantined Sensor Pantai Observations (reason_code=CONTRACT_VIOLATION) ==="
curl -sSf -H "Authorization: Bearer ${AUDIT_TOKEN}" \
  "${AGGREGATOR_URL}/internal/audit/unprocessed?source=SENSOR_PANTAI&limit=20" | node -e '
  const fs = require("fs");
  const body = JSON.parse(fs.readFileSync(0, "utf8"));
  console.log(`Quarantined SENSOR_PANTAI messages in Parker: ${(body.items || []).length}`);
  for (const item of (body.items || []).slice(0, 10)) {
    console.log(`  - ${item.message_id}: status=${item.status}, reason="${item.reason}"`);
  }
'
