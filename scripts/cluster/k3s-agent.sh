#!/usr/bin/env bash
# Bootstrap script for Node B / Node C (k3s worker agents).
# Usage on node-b / node-c (Ubuntu 24.04 x86_64):
#   SERVER_IP=192.168.1.101 NODE_IP=192.168.1.102 NODE_NAME=node-b K3S_TOKEN=<token> bash scripts/cluster/k3s-agent.sh
set -euo pipefail

SERVER_IP="${SERVER_IP:?Must set SERVER_IP (node-a IP)}"
NODE_IP="${NODE_IP:?Must set NODE_IP (this node's IP)}"
NODE_NAME="${NODE_NAME:?Must set NODE_NAME (node-b or node-c)}"
K3S_TOKEN="${K3S_TOKEN:?Must set K3S_TOKEN from /var/lib/rancher/k3s/server/node-token on node-a}"
STORE_DIR="${STORE_DIR:-/var/lib/bnpb/store}"

echo "[k3s-agent] Preparing storage directory ${STORE_DIR} on ${NODE_NAME}..."
sudo mkdir -p "${STORE_DIR}"
sudo chmod 0755 "${STORE_DIR}"

echo "[k3s-agent] Configuring insecure local registry mirror for node-a:5000..."
sudo mkdir -p /etc/rancher/k3s
cat <<EOF | sudo tee /etc/rancher/k3s/registries.yaml >/dev/null
mirrors:
  "node-a:5000":
    endpoint:
      - "http://${SERVER_IP}:5000"
EOF

echo "[k3s-agent] Joining ${NODE_NAME} (${NODE_IP}) to https://${SERVER_IP}:6443..."
curl -sfL https://get.k3s.io | K3S_URL="https://${SERVER_IP}:6443" K3S_TOKEN="${K3S_TOKEN}" INSTALL_K3S_EXEC="agent \
  --node-name=${NODE_NAME} \
  --node-ip=${NODE_IP} \
  --node-label=bnpb/storage=true \
  --node-label=bnpb/node-role=worker" sh -

echo "[k3s-agent] Done. Verify from node-a with: kubectl get nodes -o wide"
