export interface KubeLease { name: string; resourceVersion: string; holder: string | null; transitions: number }
export interface KubeConfigMap { name: string; resourceVersion: string; data: Record<string, string> }

export class KubeConflictError extends Error {
  constructor(what: string) { super(`conflict: ${what}`); }
}

// The slice of the Kubernetes API the coordinator needs. Every update is a compare-and-swap on resourceVersion.
export interface KubeApi {
  getLease(name: string): Promise<KubeLease | null>;
  createLease(name: string, holder: string): Promise<KubeLease>;
  updateLease(name: string, resourceVersion: string, holder: string | null, transitions: number): Promise<KubeLease>;
  getConfigMap(name: string): Promise<KubeConfigMap | null>;
  createConfigMap(name: string, data: Record<string, string>): Promise<KubeConfigMap>;
  updateConfigMap(name: string, resourceVersion: string, data: Record<string, string>): Promise<KubeConfigMap>;
}
