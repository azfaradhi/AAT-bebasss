#!/usr/bin/env bash
# Tier-C Bonus Script MB3-C1: Physical Network Partition / Cable Cut on Worker Node
# Usage on node-b (Ubuntu 24.04 x86_64):
#   CONTROL_PLANE_IP=192.168.1.101PEER_IP=192.168.1.103 DURATION_S=25 bash scripts/demo/mb3-c1-physical-network-cut.sh
set -euo pipefail

CONTROL_PLANE_IP="${CONTROL_PLANE_IP:?Must set CONTROL_PLANE_IP (node-a IP)}"
PEER_IP="${PEER_IP:?Must set PEER_IP (node-c IP)}"
DURATION_S="${DURATION_S:-25}"

echo "[MB3-C1] Partitioning this node from ${CONTROL_PLANE_IP} and ${PEER_IP} for ${DURATION_S}s..."
sudo iptables -I INPUT -s "${CONTROL_PLANE_IP}" -j DROP
sudo iptables -I OUTPUT -d "${CONTROL_PLANE_IP}" -j DROP
sudo iptables -I INPUT -s "${PEER_IP}" -j DROP
sudo iptables -I OUTPUT -d "${PEER_IP}" -j DROP

echo "[MB3-C1] Partition active at $(date -u +%Y-%m-%dT%H:%M:%SZ). Sleeping ${DURATION_S}s..."
sleep "${DURATION_S}"

echo "[MB3-C1] Restoring network connectivity at $(date -u +%Y-%m-%dT%H:%M:%SZ)..."
sudo iptables -D INPUT -s "${CONTROL_PLANE_IP}" -j DROP
sudo iptables -D OUTPUT -d "${CONTROL_PLANE_IP}" -j DROP
sudo iptables -D INPUT -s "${PEER_IP}" -j DROP
sudo iptables -D OUTPUT -d "${PEER_IP}" -j DROP
echo "[MB3-C1] Network healed. Verify ring repair and lease convergence on node-a."
