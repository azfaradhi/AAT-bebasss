#!/usr/bin/env bash
# Verification script for PLAT-8 (Isolasi Jaringan Storage Unit):
# 1. Negative test: a pod with role=api MUST NOT be able to connect to storage-unit:8100.
# 2. Positive test: a pod with role=aggregator MUST be able to connect to storage-unit:8100.
set -euo pipefail

NAMESPACE="${NAMESPACE:-sistem-informasi-kebencanaan-bnpb}"
TARGET_URL="${TARGET_URL:-http://storage-unit:8100/healthz}"

if [[ "${1:-}" == "--manifest-check" ]]; then
  echo "[verify-netpol] Verifying NetworkPolicy manifests in deploy/k8s..."
  RENDERED="$(kubectl kustomize deploy/k8s/overlays/dev)"
  node -e '
    const raw = process.argv[1];
    const docs = raw.split(/^---$/m).map(s => s.trim()).filter(Boolean);
    const netpols = docs.filter(d => /^kind:\s*NetworkPolicy/m.test(d));
    if (netpols.length === 0) {
      console.error("[FAIL] No NetworkPolicy found in rendered manifests!");
      process.exit(1);
    }
    const storePol = netpols.find(d => /name:\s*store-ingress/m.test(d));
    if (!storePol) {
      console.error("[FAIL] NetworkPolicy store-ingress not found!");
      process.exit(1);
    }
    const allowed = new Set();
    for (const m of storePol.matchAll(/role:[ \t]*([a-z-]+)[ \t]*$/gm)) allowed.add(m[1]);
    const values = storePol.match(/key:\s*role[\s\S]*?values:\s*(?:\[([^\]]*)\]|\n([ \t]*)-[ \t]*\S+(?:\n\2-[ \t]*\S+)*)/);
    if (values) for (const v of (values[1] ?? values[0].slice(values[0].indexOf("values:") + 7)).split(/[,\n]/)) { const t = v.replace(/^\s*-?\s*/, "").trim(); if (t) allowed.add(t); }
    if (!allowed.has("store") || !allowed.has("aggregator") || [...allowed].some((r) => !["store", "aggregator"].includes(r))) {
      console.error("[FAIL] store-ingress NetworkPolicy must allow exactly role=aggregator and role=store, found: " + [...allowed].join(","));
      process.exit(1);
    }
    console.log(`[PASS] Found ${netpols.length} NetworkPolicies including store-ingress (role=store <- role in [aggregator, store]).`);
  ' "${RENDERED}"
  exit 0
fi

echo "[verify-netpol] Running live NetworkPolicy test in namespace '${NAMESPACE}'..."

# Self-contained: throw-away pods stand in for a storage unit and for callers, so the test proves the
# policy itself (not whether a real storage service happens to be deployed). The CNI needs a few seconds
# to program rules for new pods, so the "allowed" caller is retried first; only then is the "denied"
# caller checked (it must stay blocked on every attempt).
STORE=netpol-dummy-store; AGG=netpol-probe-agg; API=netpol-probe-api
cleanup() { kubectl -n "${NAMESPACE}" delete pod "${STORE}" "${AGG}" "${API}" --ignore-not-found --wait=false >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup; sleep 2

kubectl -n "${NAMESPACE}" run "${STORE}" --restart=Never --labels="role=store" --image=busybox:1.36 \
  --command -- sh -c 'echo ok > /tmp/index.html && httpd -f -p 8100 -h /tmp' >/dev/null
for P in "${AGG}:aggregator" "${API}:api"; do
  kubectl -n "${NAMESPACE}" run "${P%%:*}" --restart=Never --labels="role=${P##*:}" \
    --image=curlimages/curl:8.7.1 --command -- sleep 600 >/dev/null
done
kubectl -n "${NAMESPACE}" wait --for=condition=Ready "pod/${STORE}" "pod/${AGG}" "pod/${API}" --timeout=120s >/dev/null
IP="$(kubectl -n "${NAMESPACE}" get pod "${STORE}" -o jsonpath='{.status.podIP}')"
URL="http://${IP}:8100/"

echo "[verify-netpol] 1/2 Positive test: role=aggregator -> ${URL} (MUST succeed, retried up to 60s)..."
ok=0
for i in $(seq 1 12); do
  if kubectl -n "${NAMESPACE}" exec "${AGG}" -- curl -sSf --max-time 4 "${URL}" >/dev/null 2>&1; then ok=1; break; fi
  sleep 5
done
if [[ "${ok}" != "1" ]]; then
  echo "[verify-netpol] FAIL: role=aggregator could not reach the store (policy too strict or CNI not ready)" >&2
  exit 1
fi
echo "[verify-netpol] PASS: role=aggregator allowed."

echo "[verify-netpol] 2/2 Negative test: role=api -> ${URL} (MUST fail every time)..."
for i in 1 2 3; do
  if kubectl -n "${NAMESPACE}" exec "${API}" -- curl -sS --max-time 4 "${URL}" >/dev/null 2>&1; then
    echo "[verify-netpol] FAIL: role=api pod reached the store (NetworkPolicy NOT enforced!)" >&2
    exit 1
  fi
done
echo "[verify-netpol] PASS: role=api blocked."
echo "[PASS] PLAT-8 store isolation enforced by NetworkPolicy."
