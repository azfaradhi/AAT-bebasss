#!/usr/bin/env bash
# P5-K6: combined fault (sensor down + broker pod killed + overload). Faults are injected ONCE;
# after that nothing may be touched by a human. Exits non-zero if the system did not self-heal.
set -euo pipefail

NS="${NAMESPACE:-sistem-informasi-kebencanaan-bnpb}"
AGGREGATOR_URL="${AGGREGATOR_URL:-http://localhost:8090}"
RECOVERY_WINDOW_S="${RECOVERY_WINDOW_S:-120}"
FAIL=0

metric() { curl -sf "${AGGREGATOR_URL}/metrics" | grep -E "$1" || true; }

echo "=== before ==="; metric 'bnpb_(breaker_state|outbox_pending)'

echo "=== inject: sensor-pantai down, rabbitmq-1 killed, overload ==="
kubectl -n "$NS" scale deployment/sensor-pantai --replicas=0
kubectl -n "$NS" delete pod rabbitmq-1 --wait=false
bash scripts/demo/p5-k5-shed.sh || { echo "[FAIL] shedding check failed"; FAIL=1; }
kubectl -n "$NS" scale deployment/sensor-pantai --replicas=1

echo "=== recovery window (${RECOVERY_WINDOW_S}s, no manual action) ==="
deadline=$((SECONDS + RECOVERY_WINDOW_S))
until kubectl -n "$NS" rollout status statefulset/rabbitmq --timeout=5s >/dev/null 2>&1 \
  && kubectl -n "$NS" rollout status deployment/sensor-pantai --timeout=5s >/dev/null 2>&1 \
  && metric 'bnpb_breaker_state\{target="sensor-pantai"\} 0' | grep -q . \
  && [[ "$(metric '^bnpb_outbox_pending ' | awk '{print $2}')" == "0" ]]; do
  if (( SECONDS >= deadline )); then echo "[FAIL] not recovered within ${RECOVERY_WINDOW_S}s"; FAIL=1; break; fi
  sleep 3
done

echo "=== after ==="; metric 'bnpb_(breaker_state|outbox_pending)'
if (( FAIL )); then echo "[FAIL] P5-K6"; exit 1; fi
echo "[PASS] P5-K6: breaker closed, broker ready, outbox drained"
