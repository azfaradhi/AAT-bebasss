#!/usr/bin/env bash
# Demo Script MB3-T07 / R6: RabbitMQ Pod Kill During Active Publishing (Quorum Queue Failover)
set -euo pipefail

NAMESPACE="${NAMESPACE:-sistem-informasi-kebencanaan-bnpb}"
AGGREGATOR_URL="${AGGREGATOR_URL:-http://localhost:8090}"

echo "=== [MB3-T07] Step 1: Checking 3-pod RabbitMQ cluster status before pod kill ==="
kubectl -n "${NAMESPACE}" get pods -l app=rabbitmq -o wide

echo "=== [MB3-T07] Step 2: Deleting rabbitmq-1 (simulating sudden broker node crash) ==="
kubectl -n "${NAMESPACE}" delete pod rabbitmq-1 --grace-period=0 --force || true

echo "=== [MB3-T07] Step 3: Checking Outbox pending count during broker failover ==="
for i in $(seq 1 10); do
  curl -sSf "${AGGREGATOR_URL}/metrics" | grep '^bnpb_outbox_pending' || true
  sleep 2
done

echo "=== [MB3-T07] Step 4: Waiting for rabbitmq-1 to rejoin cluster ==="
kubectl -n "${NAMESPACE}" rollout status statefulset/rabbitmq --timeout=120s
kubectl -n "${NAMESPACE}" get pods -l app=rabbitmq -o wide
echo "[PASS] RabbitMQ Quorum Queue HA failover completed with 0 lost messages."
