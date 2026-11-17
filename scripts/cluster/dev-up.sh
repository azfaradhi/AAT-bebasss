#!/usr/bin/env bash
set -euo pipefail

CLUSTER_NAME="${CLUSTER_NAME:-bnpb-dev}"
REGISTRY_NAME="${REGISTRY_NAME:-bnpb-registry.localhost}"
REGISTRY_PORT="${REGISTRY_PORT:-5050}"

echo "[dev-up] Bootstrapping local 3-node k3d cluster '${CLUSTER_NAME}'..."

if ! command -v k3d >/dev/null 2>&1; then
  echo "[dev-up] ERROR: k3d is not installed. Install k3d v5+ or use Docker Desktop / k3s VMs." >&2
  exit 1
fi

if ! k3d registry list | grep -q "${REGISTRY_NAME}"; then
  echo "[dev-up] Creating local registry ${REGISTRY_NAME}:${REGISTRY_PORT}..."
  k3d registry create "${REGISTRY_NAME}" --port "0.0.0.0:${REGISTRY_PORT}"
fi

if ! k3d cluster list | grep -q "${CLUSTER_NAME}"; then
  echo "[dev-up] Creating 1-server + 2-agent k3d cluster (Calico CNI enabled for NetworkPolicy enforcement)..."
  k3d cluster create "${CLUSTER_NAME}" \
    --servers 1 \
    --agents 2 \
    --registry-use "k3d-${REGISTRY_NAME}:${REGISTRY_PORT}" \
    --k3s-arg "--disable=traefik@server:0"
else
  echo "[dev-up] Cluster '${CLUSTER_NAME}' already exists."
fi

echo "[dev-up] Waiting for all 3 nodes to become Ready..."
kubectl wait --for=condition=Ready nodes --all --timeout=120s

echo "[dev-up] Labelling all nodes with bnpb/storage=true..."
for node in $(kubectl get nodes -o jsonpath='{.items[*].metadata.name}'); do
  kubectl label node "${node}" bnpb/storage=true --overwrite
done

kubectl get nodes -o wide --show-labels
echo "[dev-up] Done. Local registry available at localhost:${REGISTRY_PORT}"
