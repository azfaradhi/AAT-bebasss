#!/usr/bin/env bash
# Exam-day switch of sensor-pantai to the exam profile (Lampiran C), without changing the image.
# Usage: exam-switchover.sh <path-to-key-file-from-assistants>
set -euo pipefail

NS="${NAMESPACE:-sistem-informasi-kebencanaan-bnpb}"
KEY_FILE="${1:?usage: exam-switchover.sh <key-file>}"
[[ -f "$KEY_FILE" ]] || { echo "ERROR: key file not found: $KEY_FILE" >&2; exit 1; }

kubectl -n "$NS" create secret generic pantai-key --from-file=key="$KEY_FILE" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n "$NS" patch deployment sensor-pantai --type=json -p='[
  {"op":"add","path":"/spec/template/spec/volumes/-","value":{"name":"key","secret":{"secretName":"pantai-key"}}},
  {"op":"add","path":"/spec/template/spec/containers/0/volumeMounts/-","value":{"name":"key","mountPath":"/var/run/pantai","readOnly":true}}
]'
kubectl -n "$NS" set env deployment/sensor-pantai PANTAI_PROFILE=exam
kubectl -n "$NS" rollout status deployment/sensor-pantai --timeout=90s
kubectl -n "$NS" get pods -l app=sensor-pantai -o wide
