// In-memory Coordinator fake: single process, failover(name) simulates losing and re-acquiring leadership with a higher fence.
import type { Coordinator, CursorState, FenceToken, StorageClient } from '../types';

interface Slot { fence: FenceToken; abort: AbortController | null; cursor: { state: CursorState<unknown> | null; version: number } }

export class InMemoryCoordinator implements Coordinator {
  private slots = new Map<string, Slot>();
  private stopped = false;
  private stopWaiters: Array<() => void> = [];
  private failoverWaiters = new Map<string, Array<() => void>>();

  constructor(private readonly storage?: StorageClient, private readonly instance = 'fake-instance') {}

  private slot(name: string): Slot {
    let s = this.slots.get(name);
    if (!s) { s = { fence: 0, abort: null, cursor: { state: null, version: 0 } }; this.slots.set(name, s); }
    return s;
  }

  async runAsLeader(name: string, fn: (ctx: { fence: FenceToken; signal: AbortSignal }) => Promise<void>): Promise<void> {
    while (!this.stopped) {
      const s = this.slot(name);
      s.fence += 1;
      s.abort = new AbortController();
      if (this.storage) await this.storage.fenceBarrier(name, s.fence); // barrier BEFORE first write
      const signal = s.abort.signal;
      const failedOver = new Promise<void>((res) => { const l = this.failoverWaiters.get(name) ?? []; l.push(res); this.failoverWaiters.set(name, l); });
      const done = fn({ fence: s.fence, signal }).catch(() => undefined);
      await Promise.race([done, failedOver, new Promise<void>((res) => this.stopWaiters.push(res))]);
      if (this.stopped) { s.abort.abort(); await done; return; }
      if (signal.aborted) { await done; continue; } // re-elected
      // fn returned normally: stay leader (idle) until failover or stop
      await Promise.race([failedOver, new Promise<void>((res) => this.stopWaiters.push(res))]);
    }
  }
  /** Test control: lose leadership and immediately re-acquire with a higher fence. */
  failover(name: string): void {
    const s = this.slot(name);
    s.abort?.abort();
    for (const w of this.failoverWaiters.get(name) ?? []) w();
    this.failoverWaiters.set(name, []);
  }
  isLeader(name: string): boolean { const s = this.slots.get(name); return !!s?.abort && !s.abort.signal.aborted; }
  currentFence(name: string): FenceToken | null { const s = this.slots.get(name); return s && s.fence > 0 ? s.fence : null; }

  async readCursor<T>(name: string): Promise<{ state: CursorState<T> | null; version: string }> {
    const c = this.slot(name).cursor;
    return { state: c.state ? (structuredClone(c.state) as CursorState<T>) : null, version: String(c.version) };
  }
  async commitCursor<T>(name: string, expectedVersion: string, next: CursorState<T>, fence: FenceToken): Promise<boolean> {
    const s = this.slot(name);
    if (fence !== s.fence) return false; // zombie or stale leader
    if (String(s.cursor.version) !== expectedVersion) return false; // lost the race
    s.cursor = { state: structuredClone(next) as CursorState<unknown>, version: s.cursor.version + 1 };
    return true;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    for (const w of this.stopWaiters) w();
    this.stopWaiters = [];
  }
  get instanceName(): string { return this.instance; }
}
