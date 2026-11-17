#!/usr/bin/env bash
# Verification script for TA-6 & PLAT-7:
# Asserts every pod in namespace sistem-informasi-kebencanaan-bnpb has a valid `role` label.
# Also supports --manifest-check mode to validate deploy/k8s manifests offline when cluster is not running.
set -euo pipefail

NAMESPACE="${NAMESPACE:-sistem-informasi-kebencanaan-bnpb}"
VALID_ROLES="^(aggregator|store|broker|consumer|api|mock|sensor|other)$"

if [[ "${1:-}" == "--manifest-check" ]]; then
  echo "[verify-labels] Running static manifest check on deploy/k8s..."
  RENDERED="$(kubectl kustomize deploy/k8s/overlays/dev)"
  # Extract Pod controller kinds and verify pod template labels.role
  node -e '
    const fs = require("fs");
    const raw = process.argv[1];
    const docs = raw.split(/^---$/m).map(s => s.trim()).filter(Boolean);
    const valid = new Set(["aggregator","store","broker","consumer","api","mock","sensor","other"]);
    const controllers = new Set(["Deployment","StatefulSet","DaemonSet","Job"]);
    let count = 0;
    let errors = 0;
    for (const doc of docs) {
      const kindMatch = doc.match(/^kind:\s*(\S+)/m);
      const nameMatch = doc.match(/^\s*name:\s*(\S+)/m);
      const nsMatch = doc.match(/^\s*namespace:\s*(\S+)/m);
      if (!kindMatch || !controllers.has(kindMatch[1])) continue;
      const ns = nsMatch ? nsMatch[1] : "default";
      if (ns !== "sistem-informasi-kebencanaan-bnpb") continue;
      count++;
      const name = nameMatch ? nameMatch[1] : "unknown";
      // Check template metadata labels role
      const templateSection = doc.split(/template:/)[1] || "";
      const roleMatch = templateSection.match(/^\s+role:\s*["'\'']?([a-z]+)["'\'']?/m);
      const role = roleMatch ? roleMatch[1] : "";
      if (!valid.has(role)) {
        console.error(`[FAIL] ${kindMatch[1]}/${name} has invalid or missing pod label role="${role}"`);
        errors++;
      } else {
        console.log(`[PASS] ${kindMatch[1]}/${name} (ns=${ns}) -> role=${role}`);
      }
    }
    if (count === 0 || errors > 0) {
      console.error(`[verify-labels] FAILED (${errors} errors across ${count} workloads)`);
      process.exit(1);
    }
    console.log(`[verify-labels] OK: all ${count} workloads in sistem-informasi-kebencanaan-bnpb carry valid role labels.`);
  ' "${RENDERED}"
  exit 0
fi

echo "[verify-labels] Checking live pods in namespace '${NAMESPACE}'..."
kubectl -n "${NAMESPACE}" get pods -o json | node -e '
  const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const valid = new Set(["aggregator","store","broker","consumer","api","mock","sensor","other"]);
  if (!data.items || data.items.length === 0) {
    console.error("[verify-labels] FAIL: No pods found in namespace");
    process.exit(1);
  }
  let errors = 0;
  for (const pod of data.items) {
    const name = pod.metadata.name;
    const role = (pod.metadata.labels || {}).role;
    if (!valid.has(role)) {
      console.error(`[FAIL] Pod ${name} has invalid/missing role="${role || ""}"`);
      errors++;
    } else {
      console.log(`[PASS] Pod ${name} -> role=${role}`);
    }
  }
  if (errors > 0) process.exit(1);
  console.log(`[verify-labels] OK: all ${data.items.length} pods have valid role labels.`);
'
