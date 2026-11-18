#!/usr/bin/env bash
# P5-K5: priority load shedding (lapangan served, media shed). Needs k6 installed OUTSIDE the cluster pods.
set -euo pipefail

CLIENT_API_URL="${CLIENT_API_URL:-http://localhost:8080}"
AUTH_URL="${AUTH_URL:-http://localhost:8091}"

command -v k6 >/dev/null 2>&1 || { echo "[FAIL] k6 is required (install it on the load-generator machine)" >&2; exit 1; }
echo "=== [P5-K5] mixed-priority overload ==="
k6 run -e CLIENT_API_URL="${CLIENT_API_URL}" -e AUTH_URL="${AUTH_URL}" load-tests/p5/mixed-priority-shedding.k6.js
