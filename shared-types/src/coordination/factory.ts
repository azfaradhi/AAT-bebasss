import type { Coordinator, StorageClient } from '../m2/types';
import { HttpKubeApi } from './http-kube-api';
import { LeaseCoordinator } from './lease-coordinator';

// In a cluster (KUBERNETES_SERVICE_HOST) or against a dev apiserver (KUBE_API_URL) the Lease coordinator; otherwise null so the caller keeps its single-process fallback.
export function coordinatorFromEnv(storage: StorageClient, identity: string, env: NodeJS.ProcessEnv = process.env): Coordinator | null {
  if (!env.KUBERNETES_SERVICE_HOST && !env.KUBE_API_URL) return null;
  const kube = env.KUBE_API_URL
    ? new HttpKubeApi({ baseUrl: env.KUBE_API_URL, namespace: env.LEASE_NAMESPACE ?? 'default', leaseDurationSeconds: Number(env.LEASE_DURATION_SECONDS ?? 10) })
    : HttpKubeApi.inCluster(env);
  return new LeaseCoordinator({
    kube,
    identity,
    storage,
    leaseDurationMs: Number(env.LEASE_DURATION_SECONDS ?? 10) * 1000,
    renewIntervalMs: Number(env.LEASE_RENEW_INTERVAL_MS ?? 3000),
  });
}
