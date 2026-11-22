#!/usr/bin/env bash
# P2-K6 / K7 / K8 drill: runs load-tests/p2/aggregator-scale.k6.js from OUTSIDE the cluster while
# changing the Aggregator Deployment, then writes an evidence file with the environment header.
#
#   MODE=scale       K6: 3 -> 5 -> 2 replicas during the run (needs VUS>=10000, DURATION>=120s for the criterion)
#   MODE=rollout     K8: rolling update during the run; STRICT=1 so any non-2xx or 429 fails the run
#   MODE=throughput  K7: same load against 1 replica, then 3; prints the throughput ratio (criterion >= 2.0)
#
# Prerequisites: kubectl (KUBECONFIG pointing at the cluster), k6 on PATH (or K6="docker run --rm -i grafana/k6"),
# CLIENT_ID / CLIENT_SECRET of an `internal` client (never commit them), and a node IP of the cluster in NODE_IP.
# The script exposes client-api + auth-service through temporary NodePort Services and removes them at the end;
# it pins the HPA (min=max) during the run and restores 3..5 afterwards.
set -uo pipefail

MODE="${MODE:?MODE=scale|rollout|throughput}"
NS="${NS:-sistem-informasi-kebencanaan-bnpb}"
NODE_IP="${NODE_IP:?NODE_IP=<any cluster node IP>}"
VUS="${VUS:-10000}"
DURATION="${DURATION:-120s}"
RAMP="${RAMP:-30s}"
THINK_S="${THINK_S:-1}"
K6="${K6:-k6}"
OUT_DIR="${OUT_DIR:-../AAT-docs/m2/evidence/P2}"
STAMP="$(date +%Y-%m-%d_%H%M)"
OUT="${OUT_DIR}/${STAMP}_p2-load-${MODE}.txt"
SCRIPT="load-tests/p2/aggregator-scale.k6.js"
mkdir -p "${OUT_DIR}"

secs() { case "$1" in *m) echo $(( ${1%m} * 60 ));; *s) echo "${1%s}";; *) echo "$1";; esac; }
TOTAL=$(( $(secs "${RAMP}") * 2 + $(secs "${DURATION}") ))

cleanup() {
  kubectl -n "${NS}" delete svc client-api-nodeport auth-service-nodeport --ignore-not-found >/dev/null 2>&1 || true
  kubectl -n "${NS}" patch hpa aggregator-hpa --type merge -p '{"spec":{"minReplicas":3,"maxReplicas":5}}' >/dev/null 2>&1 || true
}
trap cleanup EXIT

pin() { # pin <replicas>: HPA min=max=N and scale, so the HPA cannot fight the drill
  kubectl -n "${NS}" patch hpa aggregator-hpa --type merge -p "{\"spec\":{\"minReplicas\":$1,\"maxReplicas\":$1}}" >/dev/null
  kubectl -n "${NS}" scale deployment/aggregator --replicas="$1" >/dev/null
  echo "[$(date +%T)] aggregator replicas -> $1" | tee -a "${OUT}"
}

kubectl -n "${NS}" expose deployment client-api --name=client-api-nodeport --type=NodePort --port=8080 --target-port=8080 >/dev/null 2>&1 || true
kubectl -n "${NS}" expose deployment auth-service --name=auth-service-nodeport --type=NodePort --port=8091 --target-port=8091 >/dev/null 2>&1 || true
API_PORT="$(kubectl -n "${NS}" get svc client-api-nodeport -o jsonpath='{.spec.ports[0].nodePort}')"
AUTH_PORT="$(kubectl -n "${NS}" get svc auth-service-nodeport -o jsonpath='{.spec.ports[0].nodePort}')"
export BASE_URL="http://${NODE_IP}:${API_PORT}" AUTH_URL="http://${NODE_IP}:${AUTH_PORT}" VUS DURATION RAMP THINK_S

{
  echo "# P2 load drill, MODE=${MODE}, ${STAMP}. Label: see the verdict lines at the end; nothing here is claimed in advance."
  echo "# nodes: $(kubectl get nodes --no-headers | wc -l); aggregator image: $(kubectl -n "${NS}" get deploy aggregator -o jsonpath='{.spec.template.spec.containers[0].image}')"
  echo "# k6: $(${K6} version 2>&1 | head -1); VUS=${VUS} DURATION=${DURATION} RAMP=${RAMP} THINK_S=${THINK_S}; load machine: $(uname -sm)"
  echo "# NOTE: record host hardware and whether the load generator shared the machine with the cluster VMs."
} > "${OUT}"

run_k6() { # run_k6 <summary-json>
  # A crossed threshold makes k6 exit non-zero; keep going so every phase is recorded, and report the code.
  STRICT="${STRICT:-0}" ${K6} run --summary-export "$1" "${SCRIPT}" 2>&1 | tee -a "${OUT}" || true
  echo "[k6 finished: $1]" | tee -a "${OUT}"
}

case "${MODE}" in
  scale)
    pin 3
    ( sleep $(( TOTAL * 35 / 100 )); pin 5; sleep $(( TOTAL * 30 / 100 )); pin 2 ) &
    run_k6 "${OUT%.txt}.summary.json"; wait
    kubectl -n "${NS}" get pods -l app=aggregator -o wide | tee -a "${OUT}"
    ;;
  rollout)
    pin 3
    export STRICT=1
    ( sleep $(( TOTAL / 2 ))
      echo "[$(date +%T)] rollout started" | tee -a "${OUT}"
      # A rolling update that changes the reported version (x-aggregator-version header): the k6 script counts v1 and v2 responses.
      if [ -n "${NEW_IMAGE:-}" ]; then kubectl -n "${NS}" set image deploy/aggregator aggregator="${NEW_IMAGE}"
      else kubectl -n "${NS}" set env deploy/aggregator AGGREGATOR_VERSION=v2; fi
      kubectl -n "${NS}" rollout status deploy/aggregator --timeout=300s | tee -a "${OUT}" ) &
    run_k6 "${OUT%.txt}.summary.json"; wait
    ;;
  throughput)
    export THINK_S=0
    for n in 1 3; do
      pin "${n}"; kubectl -n "${NS}" rollout status deploy/aggregator --timeout=300s >/dev/null
      run_k6 "${OUT%.txt}.n${n}.summary.json"
    done
    node -e '
      const m=(f)=>require(f).metrics;
      const a=m(process.argv[1]), b=m(process.argv[2]);
      const all=(x)=>x.http_reqs.rate, ok=(x)=>(x.p2_status_200||{rate:0}).rate;
      console.log(`all requests: 1 instance=${all(a).toFixed(1)}/s, 3 instances=${all(b).toFixed(1)}/s, ratio=${(all(b)/all(a)).toFixed(2)}`);
      console.log(`successful (HTTP 200) requests: 1 instance=${ok(a).toFixed(2)}/s, 3 instances=${ok(b).toFixed(2)}/s, ratio=${(ok(b)/ok(a)).toFixed(2)} (criterion >= 2.0; only meaningful when the error rate is low: error 1=${(100*a.p2_error_rate.value).toFixed(1)}%, 3=${(100*b.p2_error_rate.value).toFixed(1)}%)`);
    ' "$(cd "$(dirname "${OUT}")" && pwd)/$(basename "${OUT%.txt}").n1.summary.json" "$(cd "$(dirname "${OUT}")" && pwd)/$(basename "${OUT%.txt}").n3.summary.json" | tee -a "${OUT}"
    ;;
  *) echo "unknown MODE ${MODE}" >&2; exit 2 ;;
esac
echo "[done] evidence: ${OUT}"
