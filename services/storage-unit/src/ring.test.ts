import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpStorageClient } from '../../../shared-types/src/ring/http-storage-client';
import { Ring } from '../../../shared-types/src/ring/ring';
import { computeChecksum, hazardId } from '../../../shared-types/src/m2/ids';
import type { HazardSource, StoredHazardEvent, WriteCtx } from '../../../shared-types/src/m2/types';
import { buildUnitApp } from './app';
import { makeCluster } from './cluster-harness';
import { UnitEngine } from './engine';

const ctx = (over: Partial<WriteCtx> = {}): WriteCtx => ({ fence: 1, idempotencyKey: 'k', correlationId: 'c', fenceName: 't', ...over });
const ev = (ref: string, over: Partial<StoredHazardEvent> = {}): StoredHazardEvent => ({
  hazard_id: hazardId('BMKG', ref), source: 'BMKG' as HazardSource, source_ref_id: ref, hazard_type: 'SEISMIC', severity: 'WASPADA', area_name: 'A',
  latitude: -2, longitude: 113, occurred_at: '2026-11-12T02:43:00.000Z', ingested_at: '2026-11-12T02:51:08.000Z', attributes: {}, version: 1, ...over,
});
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('ring placement', () => {
  it('spreads keys across units within 15% of the ideal share and always picks distinct replicas', () => {
    const ring = new Ring(['a', 'b', 'c'], 2);
    const count: Record<string, number> = { a: 0, b: 0, c: 0 };
    for (let i = 0; i < 6000; i++) {
      const r = ring.replicas(hazardId('BMKG', `k-${i}`));
      expect(new Set(r).size).toBe(2);
      for (const u of r) count[u]++;
    }
    for (const u of Object.keys(count)) expect(Math.abs(count[u] - 4000)).toBeLessThan(600);
  });

  it('is stable: the same key always maps to the same replicas', () => {
    const a = new Ring(['a', 'b', 'c'], 2), b = new Ring(['c', 'a', 'b'], 2);
    for (let i = 0; i < 200; i++) expect(a.replicas(`k${i}`)).toEqual(b.replicas(`k${i}`));
  });
});

describe('loss, repair and the next loss (P1-K4, K5, K6)', () => {
  it('loses nothing when a unit and its data vanish, and survives a second loss after repair', async () => {
    const c = makeCluster();
    for (let i = 0; i < 120; i++) await c.client.upsertEvent(ev(`e-${i}`), ctx());
    const before = await c.client.checksum('BMKG');

    c.wipe('unit-node-a');
    const during = await c.client.checksum('BMKG');
    expect(during.checksum).toBe(before.checksum);
    expect(during.partial).toBe(false);
    expect((await c.client.ringStatus()).redundancy_ok).toBe(false);

    expect((await c.client.repair()).repaired).toEqual(['unit-node-a']);
    const status = await c.client.ringStatus();
    expect(status.redundancy_ok).toBe(true);
    expect(status.units.find((u) => u.unit === 'unit-node-a')!.keys).toBeGreaterThan(0);

    c.controls.setUnitState('unit-node-b', 'DOWN');
    const after = await c.client.checksum('BMKG');
    expect(after.count).toBe(120);
    expect(after.checksum).toBe(before.checksum);
    expect(after.partial).toBe(false);
  });

  it('does not declare a repaired unit STABLE while a peer was unreachable (found on k3s: silent loss after the next loss)', async () => {
    const c = makeCluster();
    for (let i = 0; i < 150; i++) await c.client.upsertEvent(ev(`g-${i}`), ctx());
    const before = await c.client.checksum('BMKG');

    c.wipe('unit-node-a'); // unit-node-a comes back empty
    c.controls.setUnitState('unit-node-b', 'DOWN'); // ...while a peer is momentarily unreachable (a timeout on a loaded node)

    // Rows replicated on {a, b} exist only on b right now: copying from the remaining source alone is incomplete.
    expect((await c.client.repair()).repaired).toEqual([]);
    expect((await c.client.ringStatus()).redundancy_ok).toBe(false);

    c.controls.setUnitState('unit-node-b', 'STABLE'); // the peer is back with its data
    expect((await c.client.repair()).repaired).toEqual(['unit-node-a']);
    expect((await c.client.ringStatus()).redundancy_ok).toBe(true);

    c.wipe('unit-node-b'); // the next loss
    const after = await c.client.checksum('BMKG');
    expect(after.count).toBe(150);
    expect(after.checksum).toBe(before.checksum);
  });

  it('uses a RECOVERING unit as a copy source: a wiped unit repaired together with a restarted peer must not lose the rows they share (found on k3s round 2)', async () => {
    const c = makeCluster();
    for (let i = 0; i < 200; i++) await c.client.upsertEvent(ev(`r-${i}`), ctx());
    const before = await c.client.checksum('BMKG');

    c.wipe('unit-node-a'); // empty disk (JOINING)
    c.controls.setUnitState('unit-node-b', 'RECOVERING'); // a peer that restarted and replayed its own log: its data is intact but it is not STABLE yet

    // Only unit-node-c is STABLE. Rows replicated on {a, b} exist only on b, so b must be read as a source too.
    expect((await c.client.repair()).repaired.sort()).toEqual(['unit-node-a', 'unit-node-b']);
    expect((await c.client.ringStatus()).redundancy_ok).toBe(true);

    c.wipe('unit-node-b'); // the next loss
    const after = await c.client.checksum('BMKG');
    expect(after.count).toBe(200);
    expect(after.checksum).toBe(before.checksum);
  });

  it('writes made while a unit is down reach it through repair', async () => {
    const c = makeCluster();
    c.controls.setUnitState('unit-node-c', 'DOWN');
    for (let i = 0; i < 40; i++) await c.client.upsertEvent(ev(`d-${i}`), ctx());
    c.controls.setUnitState('unit-node-c', 'RECOVERING');
    expect((await c.client.listEvents({ limit: 100 })).items).toHaveLength(40);
    await c.client.repair();
    c.controls.setUnitState('unit-node-a', 'DOWN');
    c.controls.setUnitState('unit-node-b', 'DOWN');
    const only = await c.client.listEvents({ limit: 100 });
    expect(only.partial).toBe(true);
    expect(only.items.length).toBeGreaterThan(0);
    const expected = computeChecksum((await c.client.listEvents({ limit: 100 })).items.map((i) => i.source_ref_id));
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a tombstone survives repair of a unit that missed it', async () => {
    const c = makeCluster();
    const e = ev('t-1');
    await c.client.upsertEvent(e, ctx());
    c.controls.setUnitState('unit-node-a', 'DOWN');
    c.controls.setUnitState('unit-node-b', 'DOWN');
    c.controls.setUnitState('unit-node-a', 'STABLE');
    c.controls.setUnitState('unit-node-b', 'STABLE');
    await c.client.tombstoneEvent(e.hazard_id, 2, ctx());
    c.wipe('unit-node-a');
    await c.client.repair();
    expect((await c.client.getEvent(e.hazard_id)).event).toBeNull();
    expect((await c.client.listEvents({ limit: 10 })).items).toHaveLength(0);
  });
});

describe('documents and fences across replicas', () => {
  it('a delete is not undone by a replica that missed it', async () => {
    const c = makeCluster();
    await c.client.putDoc('parked', 'm1', { v: 1 }, ctx());
    c.controls.setUnitState('unit-node-a', 'DOWN');
    await c.client.deleteDoc('parked', 'm1', ctx());
    c.controls.setUnitState('unit-node-a', 'STABLE');
    expect(await c.client.getDoc('parked', 'm1')).toBeNull();
    expect((await c.client.listDocs('parked', { limit: 10 })).items).toHaveLength(0);
  });

  it('a fence raised while a unit is down still rejects stale writes after repair', async () => {
    const c = makeCluster();
    c.controls.setUnitState('unit-node-a', 'DOWN');
    await c.client.fenceBarrier('sat', 5);
    c.wipe('unit-node-a');
    c.controls.setUnitState('unit-node-b', 'DOWN');
    await c.client.repair().catch(() => undefined);
    c.controls.setUnitState('unit-node-b', 'STABLE');
    await expect(c.client.putDoc('fire_state', 'x', {}, ctx({ fenceName: 'sat', fence: 4 }))).rejects.toMatchObject({ code: 'FENCED' });
  });

  it('refuses writes only when every replica is down', async () => {
    const c = makeCluster();
    for (const u of c.controls.units()) c.controls.setUnitState(u, 'DOWN');
    await expect(c.client.upsertEvent(ev('x'), ctx())).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect((await c.client.listEvents({ limit: 10 })).partial).toBe(true);
  });
});

describe('persistence', () => {
  it('replays the log after a restart and comes back RECOVERING, not authoritative', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unit-'));
    dirs.push(dir);
    const first = new UnitEngine({ unit: 'u1', node: 'n1', dataDir: dir });
    expect(first.state).toBe('JOINING');
    first.upsert(ev('p-1'), { fence: 1, fenceName: 'x' }, { mode: 'on_create', correlation_id: 'c' });
    first.putDoc('parked', 'k', { a: 1 }, { fence: 1, fenceName: 'x' });
    first.raiseFence('sat', 7);
    const second = new UnitEngine({ unit: 'u1', node: 'n1', dataDir: dir });
    expect(second.state).toBe('RECOVERING');
    expect(second.get(ev('p-1').hazard_id)).not.toBeNull();
    expect(second.getDoc('parked', 'k')?.doc).toEqual({ a: 1 });
    expect(second.pending()).toHaveLength(1);
    expect(() => second.upsert(ev('p-2'), { fence: 6, fenceName: 'sat' })).toThrow(/fenced/);
  });
});

describe('over real HTTP', () => {
  it('works through the default fetch transport on real sockets', async () => {
    const names = ['unit-a', 'unit-b', 'unit-c'];
    const apps = names.map((n) => buildUnitApp(new UnitEngine({ unit: n, node: n, initialState: 'STABLE' })));
    const urls = await Promise.all(apps.map(async (a) => { await a.listen({ port: 0, host: '127.0.0.1' }); const addr = a.server.address(); return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`; }));
    try {
      const client = new HttpStorageClient({ units: names.map((n, i) => ({ unit: n, node: n, url: urls[i] })), stateTtlMs: 0 });
      for (let i = 0; i < 25; i++) await client.upsertEvent(ev(`h-${i}`), ctx());
      expect((await client.listEvents({ limit: 100 })).items).toHaveLength(25);
      expect((await client.checksum('BMKG')).count).toBe(25);
      await apps[0].close();
      const degraded = await client.listEvents({ limit: 100 });
      expect(degraded.items).toHaveLength(25);
      expect(degraded.partial).toBe(false);
    } finally {
      await Promise.all(apps.map((a) => a.close().catch(() => undefined)));
    }
  });
});

describe('a restarted unit comes back on a new address (found on k3s: a replaced pod gets a new IP)', () => {
  it('re-learns the URL of a known unit instead of leaving it DOWN forever', async () => {
    const names = ['unit-a', 'unit-b', 'unit-c'];
    const engines = names.map((n) => new UnitEngine({ unit: n, node: n, initialState: 'STABLE' }));
    const apps = engines.map((e) => buildUnitApp(e));
    const listen = async (a: (typeof apps)[number]) => { await a.listen({ port: 0, host: '127.0.0.1' }); const addr = a.server.address(); return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`; };
    const urls = await Promise.all(apps.map(listen));
    let replacement: (typeof apps)[number] | undefined;
    try {
      const client = new HttpStorageClient({ units: names.map((n, i) => ({ unit: n, node: n, url: urls[i] })), stateTtlMs: 0 });
      for (let i = 0; i < 20; i++) await client.upsertEvent(ev(`r-${i}`), ctx());
      await apps[0].close(); // the pod dies
      expect((await client.ringStatus()).units.find((u) => u.unit === 'unit-a')!.state).toBe('DOWN');

      replacement = buildUnitApp(engines[0]); // the DaemonSet pod comes back (same hostPath data) on another IP:port
      const newUrl = await listen(replacement);
      expect(client.addUnits([{ unit: 'unit-a', node: 'unit-a', url: newUrl }])).toEqual([]); // not a new unit...
      const a = (await client.ringStatus()).units.find((u) => u.unit === 'unit-a')!;
      expect(a.state).toBe('STABLE'); // ...but its address was refreshed
      expect((await client.checksum('BMKG')).count).toBe(20);
    } finally {
      await Promise.all([...apps, replacement].map((a) => a?.close().catch(() => undefined)));
    }
  });
});

describe('a new unit joins the live ring (P1-K5, K6)', () => {
  it('takes writes while joining, is filled by repair, and the ring then survives losing an original unit', async () => {
    const { client, controls, engines, newUnit } = makeCluster();
    const refs = Array.from({ length: 300 }, (_, i) => `k-${i}`);
    for (const r of refs) await client.upsertEvent(ev(r), ctx());
    const before = await client.checksum('BMKG');

    const info = newUnit('unit-node-d');
    expect(client.addUnits([info])).toEqual(['unit-node-d']);
    expect(client.addUnits([info])).toEqual([]); // idempotent

    // Reads stay complete and writes keep succeeding while the new unit is still JOINING.
    expect(await client.checksum('BMKG')).toMatchObject({ count: 300, checksum: before.checksum, partial: false });
    for (const r of Array.from({ length: 100 }, (_, i) => `late-${i}`)) {
      const w = await client.upsertEvent(ev(r), ctx());
      expect(w.replicas_acked).toBeGreaterThanOrEqual(1);
    }
    expect(engines.get('unit-node-d')!.state).toBe('JOINING');

    expect((await client.repair()).repaired).toEqual(['unit-node-d']);
    expect(engines.get('unit-node-d')!.state).toBe('STABLE');
    const total = await client.checksum('BMKG');
    expect(total).toMatchObject({ count: 400, partial: false });

    // The new unit owns roughly RF/N of the keys, and the placement is the same one the client now uses.
    const status = await client.ringStatus();
    const d = status.units.find((u) => u.unit === 'unit-node-d')!;
    expect(d.keys).toBeGreaterThan(400 * 2 / 4 * 0.6);
    expect(status.redundancy_ok).toBe(true);

    // K6: lose an original unit after the join and nothing is lost.
    controls.setUnitState('unit-node-a', 'DOWN');
    expect(await client.checksum('BMKG')).toMatchObject({ count: 400, checksum: total.checksum, partial: false });
  });
});
