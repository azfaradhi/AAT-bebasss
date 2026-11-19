import type { Coordinator, CursorState, FenceToken, StorageClient } from '../m2/types';
import { KubeConflictError, type KubeApi } from './kube-api';

export interface LeaseCoordinatorOptions {
  kube: KubeApi;
  identity: string;
  // Barrier on the storage fence before a new leader runs (zombie protection).
  storage?: StorageClient;
  leaseDurationMs?: number;
  renewIntervalMs?: number;
  // Leadership is dropped when no renewal succeeded within this long (must be < leaseDurationMs).
  renewDeadlineMs?: number;
  retryIntervalMs?: number;
  // Monotonic clock; wall clocks are never compared between nodes.
  mono?: () => number;
}

interface Term { fence: FenceToken; abort: AbortController; leading: boolean }

// Leader election on a Kubernetes Lease. Fence token = leaseTransitions, so it only ever rises.
// A candidate treats the lease as expired only when its resourceVersion has not changed for a full leaseDuration of its own monotonic time.
export class LeaseCoordinator implements Coordinator {
  private readonly kube: KubeApi;
  private readonly leaseMs: number;
  private readonly renewMs: number;
  private readonly deadlineMs: number;
  private readonly retryMs: number;
  private readonly mono: () => number;
  private terms = new Map<string, Term>();
  private lastFence = new Map<string, FenceToken>();
  private stopped = false;
  private stopWaiters = new Set<() => void>();

  constructor(private readonly opts: LeaseCoordinatorOptions) {
    this.kube = opts.kube;
    this.leaseMs = opts.leaseDurationMs ?? 10_000;
    this.renewMs = opts.renewIntervalMs ?? 3_000;
    this.deadlineMs = opts.renewDeadlineMs ?? Math.floor(this.leaseMs * 0.7);
    this.retryMs = opts.retryIntervalMs ?? this.renewMs;
    this.mono = opts.mono ?? (() => performance.now());
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); this.stopWaiters.delete(done); resolve(); };
      const t = setTimeout(done, ms);
      this.stopWaiters.add(done);
    });
  }

  // Resolves with the new fence once this instance holds the lease.
  private async acquire(name: string): Promise<FenceToken | null> {
    let seen: { rv: string; at: number } | null = null;
    while (!this.stopped) {
      try {
        const lease = await this.kube.getLease(name);
        if (!lease) {
          return (await this.kube.createLease(name, this.opts.identity)).transitions;
        }
        if (!seen || seen.rv !== lease.resourceVersion) seen = { rv: lease.resourceVersion, at: this.mono() };
        const expired = lease.holder === null || lease.holder === this.opts.identity || this.mono() - seen.at >= this.leaseMs;
        if (expired) {
          const got = await this.kube.updateLease(name, lease.resourceVersion, this.opts.identity, lease.transitions + 1);
          return got.transitions;
        }
      } catch (err) {
        if (!(err instanceof KubeConflictError)) seen = null; // API trouble: do not count it towards expiry
      }
      await this.sleep(this.retryMs);
    }
    return null;
  }

  async runAsLeader(name: string, fn: (ctx: { fence: FenceToken; signal: AbortSignal }) => Promise<void>): Promise<void> {
    while (!this.stopped) {
      const fence = await this.acquire(name);
      if (fence === null) return;
      this.lastFence.set(name, fence);
      const term: Term = { fence, abort: new AbortController(), leading: true };
      this.terms.set(name, term);

      let done: Promise<void> = Promise.resolve();
      try {
        if (this.opts.storage) await this.opts.storage.fenceBarrier(name, fence);
        done = fn({ fence, signal: term.abort.signal }).catch(() => undefined);
      } catch {
        term.leading = false;
        term.abort.abort();
      }

      let lastOk = this.mono();
      let rv: string | null = null;
      while (term.leading && !this.stopped) {
        await this.sleep(this.renewMs);
        if (this.stopped) break;
        if (this.mono() - lastOk > this.deadlineMs) { term.leading = false; break; } // slept through the deadline (e.g. frozen process)
        try {
          const lease = await this.kube.getLease(name);
          if (!lease || lease.holder !== this.opts.identity || lease.transitions !== fence) { term.leading = false; break; }
          rv = (await this.kube.updateLease(name, lease.resourceVersion, this.opts.identity, fence)).resourceVersion;
          lastOk = this.mono();
        } catch (err) {
          if (err instanceof KubeConflictError) { term.leading = false; break; }
          if (this.mono() - lastOk > this.deadlineMs) { term.leading = false; break; }
        }
      }
      void rv;
      term.leading = false;
      term.abort.abort();
      await done;
      if (this.stopped) {
        await this.release(name, fence);
        return;
      }
    }
  }

  private async release(name: string, fence: FenceToken): Promise<void> {
    try {
      const lease = await this.kube.getLease(name);
      if (lease && lease.holder === this.opts.identity && lease.transitions === fence) await this.kube.updateLease(name, lease.resourceVersion, null, fence);
    } catch { /* best effort: the lease expires on its own */ }
  }

  isLeader(name: string): boolean {
    const t = this.terms.get(name);
    return !!t && t.leading && !t.abort.signal.aborted;
  }
  currentFence(name: string): FenceToken | null { return this.lastFence.get(name) ?? null; }

  private cm(name: string): string { return `bnpb-cursor-${name}`; }

  async readCursor<T = unknown>(name: string): Promise<{ state: CursorState<T> | null; version: string }> {
    const m = await this.kube.getConfigMap(this.cm(name));
    if (!m) return { state: null, version: '0' };
    return { state: JSON.parse(m.data.state) as CursorState<T>, version: m.resourceVersion };
  }

  async commitCursor<T = unknown>(name: string, expectedVersion: string, next: CursorState<T>, fence: FenceToken): Promise<boolean> {
    if (!this.isLeader(name) || this.terms.get(name)!.fence !== fence) return false;
    const data = { state: JSON.stringify(next), fence: String(fence) };
    try {
      if (expectedVersion === '0') { await this.kube.createConfigMap(this.cm(name), data); return true; }
      const cur = await this.kube.getConfigMap(this.cm(name));
      if (!cur || cur.resourceVersion !== expectedVersion) return false;
      if (Number(cur.data.fence ?? 0) > fence) return false;
      await this.kube.updateConfigMap(this.cm(name), expectedVersion, data);
      return true;
    } catch (err) {
      if (err instanceof KubeConflictError) return false;
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.terms.values()) { t.leading = false; t.abort.abort(); }
    for (const w of [...this.stopWaiters]) w();
  }
}
