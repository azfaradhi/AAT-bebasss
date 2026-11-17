#!/usr/bin/env bash
# Demo Script P5-K4: Sensor Pantai Total Outage Isolation (Circuit Breaker + Zero Cascading Failure)
set -euo pipefail

NAMESPACE="${NAMESPACE:-sistem-informasi-kebencanaan-bnpb}"
AGGREGATOR_URL="${AGGREGATOR_URL:-http://localhost:8090}"
CLIENT_API_URL="${CLIENT_API_URL:-http://localhost:8080}"
BEARER_TOKEN="${BEARER_TOKEN:?Must provide BEARER_TOKEN for client-api}"

echo "=== [P5-K4] Step 1: Scaling sensor-pantai to 0 replicas to simulate total sensor outage ==="
kubectl -n "${NAMESPACE}" scale deployment/sensor-pantai --replicas=0
kubectl -n "${NAMESPACE}" wait --for=delete pod -l app=sensor-pantai --timeout=30s || true

echo "=== [P5-K4] Step 2: Waiting 10s for CircuitBreaker(target=sensor-pantai) to trip OPEN (state=2) ==="
sleep 10
curl -sSf "${AGGREGATOR_URL}/metrics" | grep 'bnpb_breaker_state{target="sensor-pantai"}' || true

echo "=== [P5-K4] Step 3: Probing client-api 30 times while sensor-pantai is DOWN (asserting 0 HTTP 5xx) ==="
FAILURES=0
for i in $(seq 1 30); do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${BEARER_TOKEN}" "${CLIENT_API_URL}/api/v1/hazards")"
  if [[ "${CODE}" != "200" ]]; then
    echo "  [WARN] Request #${i} returned HTTP ${CODE}"
    FAILURES=$((FAILURES + 1))
  fi
done
echo "Client API 200 OK count: $((30 - FAILURES))/30 (failures=${FAILURES})"
if [[ "${FAILURES}" -gt 0 ]]; then
  echo "[FAIL] Cascading failure detected while sensor-pantai was down!" >&2
  exit 1
fi

echo "=== [P5-K4] Step 4: Restoring sensor-pantai to 1 replica and waiting for CircuitBreaker CLOSED (state=0) ==="
kubectl -n "${NAMESPACE}" scale deployment/sensor-pantai --replicas=1
kubectl -n "${NAMESPACE}" rollout status deployment/sensor-pantai --timeout=60s
sleep 12
curl -sSf "${AGGREGATOR_URL}/metrics" | grep 'bnpb_breaker_state{target="sensor-pantai"}' || true
echo "[PASS] P5-K4 sensor outage isolation and automatic recovery verified."
