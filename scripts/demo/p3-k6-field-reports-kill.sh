#!/usr/bin/env bash
# In-process fault-injection version: fresh receiver per request, receiver crash between the two writes,
# processor paused then killed mid-processing. For the cluster version set KUBE=1 (pod deletes) once the services are deployed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if [[ "${KUBE:-}" == "1" ]]; then echo "cluster mode is not implemented yet: services are not deployed (see handoffs)"; exit 2; fi
cd "$ROOT/services/field-report-processor"
npx tsx "$ROOT/scripts/demo/p3-k6-driver.ts"
