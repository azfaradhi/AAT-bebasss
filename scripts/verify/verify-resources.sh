#!/usr/bin/env bash
# Verification script for PLAT-6 & Lampiran B (Batas Sumber Daya per Peran Pod):
# Asserts every container in sistem-informasi-kebencanaan-bnpb has memory requests and limits
# matching Lampiran B for its pod `role` label.
# Supports --manifest-check for offline Kustomize verification and live cluster inspection.
set -euo pipefail

NAMESPACE="${NAMESPACE:-sistem-informasi-kebencanaan-bnpb}"

if [[ "${1:-}" == "--manifest-check" ]]; then
  echo "[verify-resources] Running static manifest check against Lampiran B..."
  RENDERED="$(kubectl kustomize deploy/k8s/overlays/dev)"
  node -e '
    const raw = process.argv[1];
    const docs = raw.split(/^---$/m).map(s => s.trim()).filter(Boolean);
    const expected = {
      aggregator: { req: "256Mi", lim: "512Mi" },
      store:      { req: "512Mi", lim: "1Gi" },
      broker:     { req: "512Mi", lim: "1Gi" },
      consumer:   { req: "128Mi", lim: "256Mi" },
      api:        { req: "128Mi", lim: "256Mi" },
      mock:       { req: "64Mi",  lim: "128Mi" },
      sensor:     { req: "128Mi", lim: "256Mi" },
      other:      { req: "128Mi", lim: "256Mi" },
    };
    const controllers = new Set(["Deployment","StatefulSet","DaemonSet"]);
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
      const templateSection = doc.split(/template:/)[1] || "";
      const roleMatch = templateSection.match(/^\s+role:\s*["'\'']?([a-z]+)["'\'']?/m);
      const role = roleMatch ? roleMatch[1] : "";
      const exp = expected[role];
      if (!exp) {
        console.error(`[FAIL] ${kindMatch[1]}/${name}: unknown role "${role}"`);
        errors++;
        continue;
      }
      const reqMatch = templateSection.match(/requests:\s*\n(?:\s+[^\n]+\n)*?\s+memory:\s*["'\'']?(\S+?)["'\'']?\s*$/m);
      const limMatch = templateSection.match(/limits:\s*\n(?:\s+[^\n]+\n)*?\s+memory:\s*["'\'']?(\S+?)["'\'']?\s*$/m);
      const req = reqMatch ? reqMatch[1] : "MISSING";
      const lim = limMatch ? limMatch[1] : "MISSING";
      if (req !== exp.req || lim !== exp.lim) {
        console.error(`[FAIL] ${kindMatch[1]}/${name} (role=${role}): expected ${exp.req}/${exp.lim}, got ${req}/${lim}`);
        errors++;
      } else {
        console.log(`[PASS] ${kindMatch[1]}/${name} (role=${role}) -> requests.memory=${req}, limits.memory=${lim}`);
      }
    }
    if (count === 0 || errors > 0) {
      console.error(`[verify-resources] FAILED (${errors} errors across ${count} workloads)`);
      process.exit(1);
    }
    console.log(`[verify-resources] OK: all ${count} workloads strictly match Lampiran B memory requests/limits.`);
  ' "${RENDERED}"
  exit 0
fi

echo "[verify-resources] Checking live pods in namespace '${NAMESPACE}'..."
kubectl -n "${NAMESPACE}" get pods -o json | node -e '
  const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const expected = {
    aggregator: { req: "256Mi", lim: "512Mi" },
    store:      { req: "512Mi", lim: "1Gi" },
    broker:     { req: "512Mi", lim: "1Gi" },
    consumer:   { req: "128Mi", lim: "256Mi" },
    api:        { req: "128Mi", lim: "256Mi" },
    mock:       { req: "64Mi",  lim: "128Mi" },
    sensor:     { req: "128Mi", lim: "256Mi" },
    other:      { req: "128Mi", lim: "256Mi" },
  };
  let errors = 0;
  for (const pod of data.items || []) {
    const name = pod.metadata.name;
    const role = (pod.metadata.labels || {}).role;
    const exp = expected[role];
    if (!exp) {
      console.error(`[FAIL] Pod ${name}: invalid role=${role}`);
      errors++;
      continue;
    }
    for (const c of pod.spec.containers || []) {
      const req = ((c.resources || {}).requests || {}).memory || "MISSING";
      const lim = ((c.resources || {}).limits || {}).memory || "MISSING";
      if (req !== exp.req || lim !== exp.lim) {
        console.error(`[FAIL] Pod ${name} container ${c.name} (role=${role}): expected ${exp.req}/${exp.lim}, got ${req}/${lim}`);
        errors++;
      } else {
        console.log(`[PASS] Pod ${name} (${c.name}, role=${role}) -> ${req}/${lim}`);
      }
    }
  }
  if (errors > 0) process.exit(1);
  console.log("[verify-resources] OK: all live containers match Lampiran B.");
'
