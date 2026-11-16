import { describe, expect, it } from 'vitest';
import { InMemoryStorage } from '../../test-support/contract-fakes/fakes/in-memory-storage';
import { FireSink } from './fire-sink';
import { detFrame, keyOf, retractFrame, updateFrame, type DetOpts } from './fixtures';
import { fireToEvent, nearestProvince, severityOf } from './mapping';
import { FireEngine } from './engine';
import { detection } from './fixtures';

const ctx = { fence: 1, signal: new AbortController().signal };
const A: DetOpts = { lat: -2.0, lon: 110.0, sat: 'N', time: 1200, frp: 12.5 };
const B: DetOpts = { lat: -1.996, lon: 110.0, sat: 'N20', time: 1215, frp: 7.25 };
const listAll = async (s: InMemoryStorage) => (await s.listEvents({ source: 'SATELIT', limit: 100 })).items;

describe('FireSink', () => {
  it('turns a fire seen by two satellites into exactly one WILDFIRE event with FIRE-MAP fields', async () => {
    const storage = new InMemoryStorage();
    const sink = new FireSink(storage, () => Date.parse('2026-11-27T12:30:00Z'));
    await sink.apply([detFrame(1, A), detFrame(2, B)], ctx);

    const events = await listAll(storage);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: 'SATELIT', hazard_type: 'WILDFIRE', severity: 'WASPADA', area_name: 'Kalimantan Barat',
      occurred_at: '2026-11-27T12:00:00.000Z',
      attributes: { detection_count: 2, satellites: ['N', 'N20'], max_confidence: 'n', total_frp_mw: 19.75, detection_keys: [keyOf(B), keyOf(A)] },
    });
  });

  it('keeps the hazard_id and changes attributes on update, tombstones on retract and revives on re-detection', async () => {
    const storage = new InMemoryStorage();
    const sink = new FireSink(storage);
    await sink.apply([detFrame(1, A), detFrame(2, B)], ctx);
    const [first] = await listAll(storage);

    await sink.apply([updateFrame(3, keyOf(B), { frp: 30 })], ctx);
    const [updated] = await listAll(storage);
    expect(updated.hazard_id).toBe(first.hazard_id);
    expect(updated.severity).toBe('SIAGA');
    expect(updated.attributes.total_frp_mw).toBe(42.5);

    await sink.apply([retractFrame(4, keyOf(B))], ctx);
    expect(await listAll(storage)).toHaveLength(0);

    await sink.apply([detFrame(5, B)], ctx);
    const [revived] = await listAll(storage);
    expect(revived.hazard_id).toBe(first.hazard_id);
  });

  it('is idempotent when a batch is replayed (applied twice)', async () => {
    const storage = new InMemoryStorage();
    const sink = new FireSink(storage);
    const batch = [detFrame(1, A), detFrame(2, B), updateFrame(3, keyOf(A), { frp: 40 })];
    await sink.apply(batch, ctx);
    const once = JSON.stringify(await listAll(storage));
    await sink.apply(batch, ctx);
    expect(JSON.stringify(await listAll(storage))).toBe(once);
  });

  it('a restarted sink rebuilds its state from fire_state and ends equal to a fault-free run', async () => {
    const frames = [detFrame(1, A), detFrame(2, B), detFrame(3, { ...A, lat: -1.99, sat: 'N21', time: 1230 }), updateFrame(4, keyOf(B), { frp: 31 }), retractFrame(5, keyOf(A))];
    const clean = new InMemoryStorage();
    await new FireSink(clean, () => 1_000).apply(frames, ctx);

    const crashed = new InMemoryStorage();
    await new FireSink(crashed, () => 1_000).apply(frames.slice(0, 3), ctx);
    const restarted = new FireSink(crashed, () => 1_000); // new process, empty memory
    await restarted.apply(frames.slice(1), ctx); // replay overlaps frames 2-3 (committed offset was behind)

    const strip = (es: Awaited<ReturnType<typeof listAll>>) => es.map(({ hazard_id, severity, attributes, latitude, longitude }) => ({ hazard_id, severity, attributes, latitude, longitude }));
    expect(strip(await listAll(crashed))).toEqual(strip(await listAll(clean)));
    expect(restarted.lastAppliedOffset).toBe(5);
  });
});

describe('FIRE-MAP', () => {
  it('maps severity thresholds', () => {
    expect(severityOf(5, 29.99)).toBe('WASPADA');
    expect(severityOf(6, 0)).toBe('SIAGA');
    expect(severityOf(2, 30)).toBe('SIAGA');
    expect(severityOf(20, 0)).toBe('AWAS');
    expect(severityOf(2, 100)).toBe('AWAS');
  });

  it('picks the nearest province centre', () => {
    expect(nearestProvince(-7.8, 110.36)).toBe('DI Yogyakarta');
    expect(nearestProvince(3.9, 96.7)).toBe('Aceh');
  });

  it('does not depend on member order', () => {
    const e = new FireEngine();
    [A, B].forEach((o, i) => e.detection(i + 1, detection(o)));
    const members = [...e.dets.values()];
    const id = [...e.fires.keys()][0];
    expect(fireToEvent(id, members, 'x')).toEqual(fireToEvent(id, [...members].reverse(), 'x'));
  });
});
