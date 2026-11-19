import { KubeConflictError, type KubeApi, type KubeConfigMap, type KubeLease } from './kube-api';

// In-memory API server semantics: every write bumps resourceVersion and stale writes conflict.
export class FakeKube implements KubeApi {
  private leases = new Map<string, KubeLease>();
  private maps = new Map<string, KubeConfigMap>();
  private rv = 100;
  private next(): string { return String(++this.rv); }
  unreachable = false;

  private guard(): void { if (this.unreachable) throw new Error('apiserver unreachable'); }

  async getLease(name: string): Promise<KubeLease | null> { this.guard(); const l = this.leases.get(name); return l ? { ...l } : null; }
  async createLease(name: string, holder: string): Promise<KubeLease> {
    this.guard();
    if (this.leases.has(name)) throw new KubeConflictError(`lease ${name} exists`);
    const l = { name, resourceVersion: this.next(), holder, transitions: 1 };
    this.leases.set(name, l);
    return { ...l };
  }
  async updateLease(name: string, resourceVersion: string, holder: string | null, transitions: number): Promise<KubeLease> {
    this.guard();
    const cur = this.leases.get(name);
    if (!cur || cur.resourceVersion !== resourceVersion) throw new KubeConflictError(`lease ${name}`);
    const l = { name, resourceVersion: this.next(), holder, transitions };
    this.leases.set(name, l);
    return { ...l };
  }
  async getConfigMap(name: string): Promise<KubeConfigMap | null> { this.guard(); const m = this.maps.get(name); return m ? { ...m, data: { ...m.data } } : null; }
  async createConfigMap(name: string, data: Record<string, string>): Promise<KubeConfigMap> {
    this.guard();
    if (this.maps.has(name)) throw new KubeConflictError(`configmap ${name} exists`);
    const m = { name, resourceVersion: this.next(), data: { ...data } };
    this.maps.set(name, m);
    return { ...m, data: { ...m.data } };
  }
  async updateConfigMap(name: string, resourceVersion: string, data: Record<string, string>): Promise<KubeConfigMap> {
    this.guard();
    const cur = this.maps.get(name);
    if (!cur || cur.resourceVersion !== resourceVersion) throw new KubeConflictError(`configmap ${name}`);
    const m = { name, resourceVersion: this.next(), data: { ...data } };
    this.maps.set(name, m);
    return { ...m, data: { ...m.data } };
  }

  // Test hook: another instance takes the lease over (holder changes, transitions + 1).
  async steal(name: string, holder: string): Promise<void> {
    const cur = this.leases.get(name);
    if (!cur) { await this.createLease(name, holder); return; }
    await this.updateLease(name, cur.resourceVersion, holder, cur.transitions + 1);
  }
}
