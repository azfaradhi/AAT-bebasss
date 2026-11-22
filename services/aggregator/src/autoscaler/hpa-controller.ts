// BON-3 (MB2-C1): Self-Adjusting Capacity Controller (Kubernetes HPA v2 proportional algorithm with scale-down stabilization window).
// Monitors per-instance request rate / utilization from Prometheus /metrics endpoints and scales the Aggregator pool between minReplicas and maxReplicas.

export interface HpaPolicy {
  minReplicas: number;
  maxReplicas: number;
  // Target value corresponding to 100% capacity per instance (e.g. 100 req/s at 100%, so 70% averageUtilization = 70 req/s)
  maxCapacityPerReplica: number;
  targetAverageUtilizationPct: number; // default 70 (from deploy/k8s/aggregator/hpa.yaml)
  scaleDownStabilizationMs: number;
  tolerance?: number; // default 0.10 (Kubernetes HPA default 10% deadband)
}

export interface HpaEvaluation {
  currentReplicas: number;
  desiredReplicasRaw: number;
  desiredReplicasStabilized: number;
  averageUtilizationPct: number;
  averageValuePerReplica: number;
  action: 'scale_up' | 'scale_down' | 'noop';
}

export class HpaController {
  private readonly history: Array<{ ts: number; desired: number }> = [];
  private readonly tolerance: number;

  constructor(
    private readonly policy: HpaPolicy,
    private readonly now: () => number = Date.now,
  ) {
    this.tolerance = policy.tolerance ?? 0.1;
  }

  evaluate(currentReplicas: number, perReplicaValues: number[]): HpaEvaluation {
    const t = this.now();
    const count = Math.max(1, currentReplicas);
    const sum = perReplicaValues.reduce((a, b) => a + b, 0);
    const avgValue = sum / count;
    const avgUtilPct = (avgValue / this.policy.maxCapacityPerReplica) * 100;
    const usageRatio = avgUtilPct / this.policy.targetAverageUtilizationPct;

    let rawDesired = currentReplicas;
    if (Math.abs(1.0 - usageRatio) > this.tolerance) {
      rawDesired = Math.ceil(currentReplicas * usageRatio);
    }
    rawDesired = Math.max(this.policy.minReplicas, Math.min(this.policy.maxReplicas, rawDesired));

    // Prune history outside the scale-down stabilization window
    const cutoff = t - this.policy.scaleDownStabilizationMs;
    while (this.history.length > 0 && this.history[0].ts < cutoff) {
      this.history.shift();
    }
    this.history.push({ ts: t, desired: rawDesired });

    let stabilized = rawDesired;
    if (rawDesired < currentReplicas) {
      // Scale-down stabilization: choose the highest recommendation within the stabilization window
      stabilized = Math.max(...this.history.map((h) => h.desired));
      stabilized = Math.min(currentReplicas, Math.max(this.policy.minReplicas, stabilized));
    }

    const action =
      stabilized > currentReplicas
        ? 'scale_up'
        : stabilized < currentReplicas
          ? 'scale_down'
          : 'noop';

    return {
      currentReplicas,
      desiredReplicasRaw: rawDesired,
      desiredReplicasStabilized: stabilized,
      averageUtilizationPct: Number(avgUtilPct.toFixed(1)),
      averageValuePerReplica: Number(avgValue.toFixed(1)),
      action,
    };
  }
}

// Parses total HTTP server requests from a Prometheus text exposition payload (/metrics)
export function parsePrometheusHttpRequestCount(metricsText: string): number {
  let total = 0;
  for (const line of metricsText.split('\n')) {
    if (line.startsWith('bnpb_http_server_request_duration_seconds_count')) {
      const parts = line.trim().split(/\s+/);
      const val = Number(parts[parts.length - 1]);
      if (Number.isFinite(val)) total += val;
    }
  }
  return total;
}
