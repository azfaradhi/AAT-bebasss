#!/usr/bin/env bash
# Bootstrap script for Node A (k3s control-plane + worker + local container registry).
# Usage on node-a (Ubuntu 24.04 x86_64):
#   NODE_IP=192.168.1.101 NODE_NAME=node-a bash scripts/cluster/k3s-server.sh
set -euo pipefail

NODE_IP="${NODE_IP:?Must set NODE_IP (e.g. 192.168.1.101)}"
NODE_NAME="${NODE_NAME:-node-a}"
STORE_DIR="${STORE_DIR:-/var/lib/bnpb/store}"

echo "[k3s-server] Preparing storage directory ${STORE_DIR} on ${NODE_NAME}..."
sudo mkdir -p "${STORE_DIR}"
sudo chmod 0755 "${STORE_DIR}"

echo "[k3s-server] Configuring insecure local registry mirror for node-a:5000..."
sudo mkdir -p /etc/rancher/k3s
cat <<EOF | sudo tee /etc/rancher/k3s/registries.yaml >/dev/null
mirrors:
  "node-a:5000":
    endpoint:
      - "http://${NODE_IP}:5000"
EOF

echo "[k3s-server] Installing k3s server on ${NODE_NAME} (${NODE_IP})..."
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="server \
  --node-name=${NODE_NAME} \
  --node-ip=${NODE_IP} \
  --advertise-address=${NODE_IP} \
  --tls-san=${NODE_IP} \
  --tls-san=${NODE_NAME} \
  --disable=traefik \
  --write-kubeconfig-mode=0644 \
  --node-label=bnpb/storage=true \
  --node-label=bnpb/node-role=control-plane" sh -

echo "[k3s-server] Waiting for ${NODE_NAME} to become Ready..."
sudo k3s kubectl wait --for=condition=Ready "node/${NODE_NAME}" --timeout=120s

echo "[k3s-server] Node token (copy out-of-band to node-b and node-c; NEVER commit to git):"
echo "  sudo cat /var/lib/rancher/k3s/server/node-token"
