import { describe, expect, it } from 'vitest';
import type { HazardEvent } from '../../../../shared-types/src/hazard-event';
import { hazardId } from '../../../../shared-types/src/m2/ids';
import { InMemoryStorage } from '../../test-support/contract-fakes/fakes/in-memory-storage';
import { StorageCanonicalStore } from './storage-canonical-store';

const ev = (ref: string, occurred: string, over: Partial<HazardEvent> = {}): HazardEvent => ({
  hazard_id: '', source: 'BMKG', source_ref_id: ref, hazard_type: 'SEISMIC', severity: 'WASPADA', area_name: 'A', latitude: 1, longitude: 2,
  occurred_at: occurred, ingested_at: '2026-11-12T03:00:00.000Z', attributes: {}, ...over,
});
const make = () => { const storage = new InMemoryStorage(); return { storage, store: new StorageCanonicalStore({ storage, listCacheMs: 0 }) }; };

describe('StorageCanonicalStore', () => {
  it('upserts with the contract id, reports created once and queues one outbox item', async () => {
    const { storage, store } = make();
    const a = await store.upsert(ev('q1', '2026-11-12T01:00:00.000Z'), 'c');
    const b = await store.upsert(ev('q1', '2026-11-12T01:00:00.000Z'), 'c');
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(a.event.hazard_id).toBe(hazardId('BMKG', 'q1'));
    expect(await storage.outboxPending()).toBe(1);
  });

  it('lists newest occurred_at first, honours hazardType, since and limit', async () => {
    const { store } = make();
    await store.upsert(ev('a', '2026-11-12T01:00:00.000Z'), 'c');
    await store.upsert(ev('b', '2026-11-12T03:00:00.000Z'), 'c');
    await store.upsert(ev('c', '2026-11-12T02:00:00.000Z', { source: 'PVMBG', hazard_type: 'VOLCANIC' }), 'c');
    expect((await store.list({})).data.map((e) => e.source_ref_id)).toEqual(['b', 'c', 'a']);
    expect((await store.list({ hazardType: 'SEISMIC' })).data.map((e) => e.source_ref_id)).toEqual(['b', 'a']);
    expect((await store.list({ since: '2026-11-12T02:00:00.000Z' })).data.map((e) => e.source_ref_id)).toEqual(['b', 'c']);
    expect((await store.list({ limit: 1 })).data).toHaveLength(1);
  });

  it('tracks staleness per source and only the relevant source affects a typed list', async () => {
    const { store } = make();
    await store.markSourceStale('PVMBG');
    expect((await store.list({ hazardType: 'SEISMIC' })).meta.stale_since).toBeNull();
    const volcanic = await store.list({ hazardType: 'VOLCANIC' });
    expect(volcanic.meta.stale_since).not.toBeNull();
    await store.markSourceFresh('PVMBG');
    expect((await store.list({ hazardType: 'VOLCANIC' })).meta.stale_since).toBeNull();
    expect(await store.getLastSuccessAt('PVMBG')).toBeInstanceOf(Date);
    expect(await store.getLastSuccessAt('BMKG')).toBeNull();
  });

  it('keeps the first stale_since while the outage continues', async () => {
    let t = Date.parse('2026-11-12T00:00:00.000Z');
    const storage = new InMemoryStorage();
    const store = new StorageCanonicalStore({ storage, clock: () => t, listCacheMs: 0 });
    await store.markSourceStale('BMKG');
    t += 60_000;
    await store.markSourceStale('BMKG');
    expect((await store.list({ hazardType: 'SEISMIC' })).meta.stale_since).toBe('2026-11-12T00:00:00.000Z');
  });
});
