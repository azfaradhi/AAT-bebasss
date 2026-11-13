// Conformance suite for StorageClient. `make()` returns a fresh client.
// Tests needing fault injection are skipped when `controls` is absent.
import { describe, expect, it } from 'vitest';
import type { HazardSource, StorageClient, StoredHazardEvent, WriteCtx } from '../types';
import { FencedError } from '../types';
import { computeChecksum, hazardId } from '../ids';
import type { FakeStorageControls } from '../fakes/in-memory-storage';

export interface StorageHarness { client: StorageClient; controls?: FakeStorageControls }

export const ctx = (over: Partial<WriteCtx> = {}): WriteCtx => ({ fence: 1, idempotencyKey: 'k', correlationId: 'c-1', fenceName: 'test', ...over });

export function ev(source: HazardSource, ref: string, over: Partial<StoredHazardEvent> = {}): StoredHazardEvent {
  return {
    hazard_id: hazardId(source, ref), source, source_ref_id: ref,
    hazard_type: source === 'SATELIT' ? 'WILDFIRE' : source === 'PVMBG' ? 'VOLCANIC' : source === 'SENSOR_PANTAI' ? 'COASTAL' : 'SEISMIC',
    severity: 'WASPADA', area_name: 'Area', latitude: -2.5, longitude: 113.8,
    occurred_at: '2026-11-12T02:43:00.000Z', ingested_at: '2026-11-12T02:51:08.000Z', attributes: {}, version: 1, ...over,
  };
}

export function storageConformance(name: string, make: () => Promise<StorageHarness> | StorageHarness): void {
  describe(`StorageClient conformance: ${name}`, () => {
    it('S1 upsert is idempotent and created flag is true only once', async () => {
      const { client } = await make();
      const e = ev('BMKG', 'eq-1');
      expect((await client.upsertEvent(e, ctx())).created).toBe(true);
      const again = await client.upsertEvent(e, ctx());
      expect(again.created).toBe(false);
      expect(again.applied).toBe(false);
      expect((await client.listEvents({ limit: 10 })).items).toHaveLength(1);
    });

    it('S2 last-writer-wins by version; ingested_at never changes on update', async () => {
      const { client } = await make();
      await client.upsertEvent(ev('SATELIT', 'fire-a', { version: 5, severity: 'WASPADA' }), ctx());
      const r = await client.upsertEvent(ev('SATELIT', 'fire-a', { version: 9, severity: 'AWAS', ingested_at: '2030-01-01T00:00:00.000Z' }), ctx());
      expect(r.applied).toBe(true);
      expect((await client.upsertEvent(ev('SATELIT', 'fire-a', { version: 7, severity: 'NORMAL' }), ctx())).applied).toBe(false);
      const got = (await client.getEvent(hazardId('SATELIT', 'fire-a'))).event!;
      expect(got.severity).toBe('AWAS');
      expect(got.ingested_at).toBe('2026-11-12T02:51:08.000Z');
      expect('version' in got).toBe(false); // version is internal
    });

    it('S3 listing order is (ingested_at, hazard_id) and pagination walks everything exactly once', async () => {
      const { client } = await make();
      const all: string[] = [];
      for (let i = 0; i < 57; i++) {
        const e = ev('BMKG', `eq-${i}`, { ingested_at: `2026-11-12T02:00:${String(Math.floor(i / 3)).padStart(2, '0')}.000Z` }); // ties on ingested_at
        all.push(e.hazard_id);
        await client.upsertEvent(e, ctx());
      }
      const seen: string[] = [];
      let cursor: string | undefined;
      let guard = 0;
      do {
        const p = await client.listEvents({ limit: 10, cursor });
        seen.push(...p.items.map((i) => i.hazard_id));
        cursor = p.next_cursor ?? undefined;
      } while (cursor && ++guard < 20);
      expect(new Set(seen).size).toBe(57);
      expect(seen).toHaveLength(57);
      const expected = (await client.listEvents({ limit: 1000 })).items.map((i) => i.hazard_id);
      expect(seen).toEqual(expected);
      for (let i = 1; i < expected.length; i++) {
        const a = (await client.getEvent(expected[i - 1])).event!, b = (await client.getEvent(expected[i])).event!;
        expect(a.ingested_at < b.ingested_at || (a.ingested_at === b.ingested_at && Buffer.compare(Buffer.from(a.hazard_id), Buffer.from(b.hazard_id)) < 0)).toBe(true);
      }
    });

    it('S4 since filters ingested_at >= since; source filter works', async () => {
      const { client } = await make();
      await client.upsertEvent(ev('BMKG', 'a', { ingested_at: '2026-11-12T01:00:00.000Z' }), ctx());
      await client.upsertEvent(ev('PVMBG', 'b', { ingested_at: '2026-11-12T02:00:00.000Z' }), ctx());
      expect((await client.listEvents({ limit: 10, since: '2026-11-12T02:00:00.000Z' })).items.map((i) => i.source_ref_id)).toEqual(['b']);
      expect((await client.listEvents({ limit: 10, source: 'BMKG' })).items.map((i) => i.source_ref_id)).toEqual(['a']);
    });

    it('S5 tombstoned events disappear from list, checksum and aggregate', async () => {
      const { client } = await make();
      await client.upsertEvent(ev('SATELIT', 'f1', { version: 1 }), ctx());
      await client.upsertEvent(ev('SATELIT', 'f2', { version: 1 }), ctx());
      expect((await client.tombstoneEvent(hazardId('SATELIT', 'f1'), 2, ctx(), 'fire-new')).applied).toBe(true);
      expect((await client.listEvents({ limit: 10 })).items.map((i) => i.source_ref_id)).toEqual(['f2']);
      const cs = await client.checksum('SATELIT');
      expect(cs.count).toBe(1);
      expect(cs.checksum).toBe(computeChecksum(['f2']));
      expect((await client.aggregate({ bucket: 'day' })).total).toBe(1);
    });

    it('S6 checksum follows Lampiran A (sorted byte order, \\n joined, no trailing newline)', async () => {
      const { client } = await make();
      for (const r of ['b', 'a', 'C', 'ab']) await client.upsertEvent(ev('BMKG', r), ctx());
      const cs = await client.checksum('BMKG');
      expect(cs.count).toBe(4);
      expect(cs.checksum).toBe(computeChecksum(['C', 'a', 'ab', 'b'])); // byte order: uppercase before lowercase
      expect(cs.checksum).toMatch(/^[0-9a-f]{64}$/);
    });

    it('S7 locate returns primary + replica on distinct nodes; unknown id returns []', async () => {
      const { client } = await make();
      const e = ev('BMKG', 'loc-1');
      await client.upsertEvent(e, ctx());
      const l = await client.locate(e.hazard_id);
      expect(l.locations.length).toBeGreaterThanOrEqual(2);
      expect(l.locations.filter((x) => x.role === 'primary')).toHaveLength(1);
      expect(new Set(l.locations.map((x) => x.node)).size).toBe(l.locations.length);
      expect((await client.locate('hz-doesnotexist')).locations).toEqual([]);
    });

    it('S8 outbox: created event yields exactly one outbox item; claim leases; publish clears; no duplicate on rewrite', async () => {
      const { client, controls } = await make();
      const e = ev('SENSOR_PANTAI', 'obs-1', { severity: 'AWAS' });
      await client.upsertEvent(e, ctx({ outbox: { mode: 'on_create', priority: 'critical' } }));
      await client.upsertEvent(e, ctx({ outbox: { mode: 'on_create', priority: 'critical' } }));
      expect(await client.outboxPending()).toBe(1);
      const first = await client.claimOutbox(10, 1000);
      expect(first).toHaveLength(1);
      expect(first[0].priority).toBe('critical');
      expect(await client.claimOutbox(10, 1000)).toHaveLength(0); // leased
      controls?.tick(1500);
      if (controls) expect(await client.claimOutbox(10, 1000)).toHaveLength(1); // lease expired → redelivered (at-least-once)
      await client.markOutboxPublished([first[0].message_id]);
      expect(await client.outboxPending()).toBe(0);
    });

    it('S9 docs: put/get/list/delete with prefix and pagination; version guards stale writes', async () => {
      const { client } = await make();
      for (let i = 0; i < 25; i++) await client.putDoc('field_reports', `fr-${String(i).padStart(2, '0')}`, { i }, ctx());
      expect(await client.getDoc('field_reports', 'fr-03')).toEqual({ i: 3 });
      const seen: string[] = [];
      let cursor: string | undefined;
      do { const p = await client.listDocs<{ i: number }>('field_reports', { prefix: 'fr-', limit: 10, cursor }); seen.push(...p.items.map((x) => x.key)); cursor = p.next_cursor ?? undefined; } while (cursor);
      expect(seen).toHaveLength(25);
      await client.putDoc('parked', 'm1', { v: 2 }, ctx(), { version: 2 });
      await client.putDoc('parked', 'm1', { v: 1 }, ctx(), { version: 1 });
      expect(await client.getDoc('parked', 'm1')).toEqual({ v: 2 });
      await client.deleteDoc('parked', 'm1', ctx());
      expect(await client.getDoc('parked', 'm1')).toBeNull();
    });

    it('S10 fencing: after fenceBarrier(token N), writes with a lower token are rejected, equal/higher accepted', async () => {
      const { client } = await make();
      await client.fenceBarrier('bmkg', 3);
      await expect(client.upsertEvent(ev('BMKG', 'z1'), ctx({ fenceName: 'bmkg', fence: 2 }))).rejects.toBeInstanceOf(FencedError);
      await expect(client.putDoc('parked', 'x', {}, ctx({ fenceName: 'bmkg', fence: 1 }))).rejects.toBeInstanceOf(FencedError);
      await expect(client.upsertEvent(ev('BMKG', 'z2'), ctx({ fenceName: 'bmkg', fence: 3 }))).resolves.toMatchObject({ applied: true });
      await expect(client.upsertEvent(ev('BMKG', 'z3'), ctx({ fenceName: 'other', fence: 1 }))).resolves.toMatchObject({ applied: true }); // fences are per name
    });

    it('S11 aggregate: categories are mutually exclusive and sum to total; tsunami = SEISMIC + potential_tsunami', async () => {
      const { client } = await make();
      await client.upsertEvent(ev('BMKG', 'q1', { attributes: { potential_tsunami: true } }), ctx());
      await client.upsertEvent(ev('BMKG', 'q2', { attributes: { potential_tsunami: false } }), ctx());
      await client.upsertEvent(ev('PVMBG', 'v1'), ctx());
      await client.upsertEvent(ev('SATELIT', 'f1'), ctx());
      await client.upsertEvent(ev('SENSOR_PANTAI', 'o1', { severity: 'AWAS' }), ctx());
      const a = await client.aggregate({ bucket: 'day' });
      const b = a.by_type_over_time[0];
      expect([b.gempa, b.tsunami, b.gunung_berapi, b.kebakaran_hutan, b.pesisir]).toEqual([1, 1, 1, 1, 1]);
      expect(a.total).toBe(5);
      expect(Object.values(a.by_severity).reduce((x, y) => x + y, 0)).toBe(5);
      expect(a.by_area.reduce((x, y) => x + y.count, 0)).toBe(5);
    });

    it('S12 (fault) one unit down: still complete (RF=2) and partial=false; two units down: partial=true with unit names, never throws on reads', async () => {
      const { client, controls } = await make();
      if (!controls) return;
      for (let i = 0; i < 30; i++) await client.upsertEvent(ev('BMKG', `p-${i}`), ctx());
      const [u1, u2] = controls.units();
      controls.setUnitState(u1, 'DOWN');
      let p = await client.listEvents({ limit: 100 });
      expect(p.items).toHaveLength(30);
      expect(p.partial).toBe(false);
      controls.setUnitState(u2, 'DOWN');
      p = await client.listEvents({ limit: 100 });
      expect(p.partial).toBe(true);
      expect(p.unavailable_units.sort()).toEqual([u1, u2].sort());
      expect((await client.checksum('BMKG')).partial).toBe(true);
      expect((await client.aggregate({ bucket: 'day' })).partial).toBe(true);
    });

    it('S13 (fault) a RECOVERING unit is NOT treated as authoritative; after repair it is', async () => {
      const { client, controls } = await make();
      if (!controls) return;
      for (let i = 0; i < 20; i++) await client.upsertEvent(ev('BMKG', `r-${i}`), ctx());
      const [u1, u2] = controls.units();
      controls.setUnitState(u1, 'RECOVERING');
      controls.setUnitState(u2, 'DOWN');
      const p = await client.listEvents({ limit: 100 });
      expect(p.partial).toBe(true); // keys whose only live replica is recovering must not silently look complete
      controls.setUnitState(u1, 'STABLE');
      controls.setUnitState(u2, 'STABLE');
      expect((await client.listEvents({ limit: 100 })).partial).toBe(false);
      expect((await client.ringStatus()).redundancy_ok).toBe(true);
    });
  });
}
