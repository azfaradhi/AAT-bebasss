import { describe, expect, it } from 'vitest';
import { FakeKube } from '../../../../shared-types/src/coordination/fake-kube';
import { LeaseCoordinator } from '../../../../shared-types/src/coordination/lease-coordinator';
import { coordinatorConformance, type CoordHarness } from '../../test-support/contract-fakes/conformance/coordinator.conformance';
import { InMemoryStorage } from '../../test-support/contract-fakes/fakes/in-memory-storage';

const fast = { leaseDurationMs: 150, renewIntervalMs: 20, renewDeadlineMs: 100, retryIntervalMs: 10 };

function make(kube = new FakeKube(), identity = 'pod-a', storage = new InMemoryStorage()) {
  const coordinator = new LeaseCoordinator({ kube, identity, storage, ...fast });
  return { kube, coordinator, storage };
}

coordinatorConformance('LeaseCoordinator on a Kubernetes Lease', (): CoordHarness => {
  const { kube, coordinator, storage } = make();
  return { coordinator, storage, failover: (name) => { void kube.steal(name, 'intruder'); } };
});

const until = async (cond: () => boolean, ms = 2000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 5)); } };

describe('two instances, one lease', () => {
  it('only one runs; the other takes over after the first stops, with a higher fence', async () => {
    const kube = new FakeKube();
    const a = make(kube, 'pod-a').coordinator, b = make(kube, 'pod-b').coordinator;
    const ran: string[] = []; const fences: Record<string, number> = {};
    const lead = (id: string) => async (c: { fence: number; signal: AbortSignal }) => { ran.push(id); fences[id] = c.fence; await new Promise<void>((r) => c.signal.addEventListener('abort', () => r())); };
    const ra = a.runAsLeader('x', lead('a'));
    await until(() => ran.includes('a'));
    const rb = b.runAsLeader('x', lead('b'));
    await new Promise((r) => setTimeout(r, 400));
    expect(ran).toEqual(['a']);
    expect(a.isLeader('x')).toBe(true);
    expect(b.isLeader('x')).toBe(false);
    await a.stop(); await ra;
    await until(() => ran.includes('b'));
    expect(fences.b).toBeGreaterThan(fences.a);
    await b.stop(); await rb;
  });

  it('a leader that cannot reach the API gives up before the lease can be taken (no split brain)', async () => {
    const kube = new FakeKube();
    const a = make(kube, 'pod-a').coordinator;
    let signal: AbortSignal | null = null;
    const ra = a.runAsLeader('y', async (c) => { signal = c.signal; await new Promise<void>((r) => c.signal.addEventListener('abort', () => r())); });
    await until(() => signal !== null);
    kube.unreachable = true;
    const lostAt = Date.now();
    await until(() => (signal as AbortSignal | null)!.aborted);
    expect(Date.now() - lostAt).toBeLessThan(fast.leaseDurationMs + 100);
    expect(a.isLeader('y')).toBe(false);
    kube.unreachable = false;
    await a.stop(); await ra;
  });

  it('a frozen leader that wakes up after takeover is fenced out of storage and cursor commits', async () => {
    const kube = new FakeKube();
    const storage = new InMemoryStorage();
    // pod-a's view of the API server hangs while it is frozen
    let thaw: () => void = () => undefined;
    let frozen = false;
    const gate = async () => { if (frozen) await new Promise<void>((r) => { thaw = r; }); };
    const viaA = new Proxy(kube, { get: (t, k) => (typeof (t as any)[k] === 'function' ? async (...a: unknown[]) => { await gate(); return (t as any)[k](...a); } : (t as any)[k]) });
    const a = new LeaseCoordinator({ kube: viaA, identity: 'pod-a', storage, ...fast });
    const b = make(kube, 'pod-b', storage).coordinator;
    let fa = 0, fb = 0;
    let aSignal: AbortSignal | null = null;
    const ra = a.runAsLeader('z', async (c) => { fa = c.fence; aSignal = c.signal; await new Promise<void>((r) => c.signal.addEventListener('abort', () => r())); });
    await until(() => fa > 0);
    const stale = await a.readCursor('z');
    frozen = true;
    await new Promise((r) => setTimeout(r, 40));
    const rb = b.runAsLeader('z', async (c) => { fb = c.fence; });
    await until(() => fb > 0);
    expect(fb).toBeGreaterThan(fa);
    // pod-a wakes up believing nothing happened
    frozen = false; thaw();
    const ev = { hazard_id: 'hz-000000000001', source: 'BMKG' as const, source_ref_id: 'r', hazard_type: 'SEISMIC' as const, severity: 'WASPADA' as const, area_name: 'A', latitude: 0, longitude: 0, occurred_at: '2026-11-12T00:00:00.000Z', ingested_at: '2026-11-12T00:00:01.000Z', attributes: {}, version: 1 };
    await expect(storage.upsertEvent(ev, { fence: fa, fenceName: 'z', idempotencyKey: 'k', correlationId: 'c' })).rejects.toMatchObject({ code: 'FENCED' });
    expect(await a.commitCursor('z', stale.version, { position: 1, last_ingested_at: null, updated_by: 'a' }, fa)).toBe(false);
    await until(() => (aSignal as AbortSignal | null)!.aborted);
    expect(a.isLeader('z')).toBe(false);
    const cur = await b.readCursor('z');
    expect(await b.commitCursor('z', cur.version, { position: 2, last_ingested_at: null, updated_by: 'b' }, fb)).toBe(true);
    await a.stop(); await b.stop(); await ra; await rb;
  });
});
