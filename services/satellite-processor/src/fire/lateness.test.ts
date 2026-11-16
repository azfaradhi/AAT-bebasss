import { describe, expect, it } from 'vitest';
import { InMemoryStorage } from '../../test-support/contract-fakes/fakes/in-memory-storage';
import { FireEngine } from './engine';
import { FireSink } from './fire-sink';
import { detFrame, detection, keyOf, updateFrame, type DetOpts } from './fixtures';

const ctx = { fence: 1, signal: new AbortController().signal };
const at = (time: number, lat = -2.0, extra: Partial<DetOpts> = {}): DetOpts => ({ lat, lon: 110.0, time, ...extra });
// Far away detection that only advances the event-time clock (watermark = max t - 360 min)
const clock = (time: number, date = '2026-11-27'): DetOpts => ({ lat: 5.0, lon: 100.0, time, date });

describe('watermark and allowed lateness', () => {
  it('applies an in-bound late detection to its fire and counts it', () => {
    const e = new FireEngine();
    e.detection(1, detection(at(1200)));
    e.detection(2, detection(clock(1800))); // max t 18:00 -> watermark 12:00
    e.detection(3, detection(at(1200, -1.996, { sat: 'N20' }))); // t == watermark: still in bound, arrives behind max t
    expect(e.fires.size).toBe(1);
    expect(e.counters).toMatchObject({ lateApplied: 1, lateBeyond: 0 });
  });

  it('counts a beyond-bound detection, never merges it, and keeps a report entry', () => {
    const e = new FireEngine();
    e.detection(1, detection(at(1200)));
    e.detection(2, detection(clock(1800)));
    e.detection(3, detection(at(1159, -1.996, { sat: 'N20' }))); // 11:59 < watermark 12:00
    expect(e.fires.size).toBe(0);
    expect(e.counters.lateBeyond).toBe(1);
    expect(e.lateLog).toEqual([{ key: keyOf(at(1159, -1.996, { sat: 'N20' })), offset: 3, t: '2026-11-27T11:59:00.000Z' }]);
    expect(e.dets.has(keyOf(at(1159, -1.996, { sat: 'N20' })))).toBe(false);
  });

  it('finalizes a fire once watermark passes its latest detection + 360 min and frees its state', () => {
    const e = new FireEngine();
    e.detection(1, detection(at(1200)));
    e.detection(2, detection(at(1210, -1.996)));
    expect(e.fires.size).toBe(1);
    e.detection(3, detection(clock(600, '2026-11-28'))); // next day 06:00 -> watermark 00:00 of 11-28, fire latest 12:10 + 6 h < watermark
    e.closeExpired(3);
    expect(e.fires.size).toBe(0);
    expect(e.counters.finalizedFires).toBe(1);
    expect(e.dets.has(keyOf(at(1200)))).toBe(false);
    expect(e.takeChanges().fires.get([...[]][0] as never)).toBeUndefined();
  });

  it('ignores updates to a frozen detection even before the memory is reclaimed', () => {
    const e = new FireEngine();
    e.detection(1, detection(at(1200)));
    e.detection(2, detection(at(1210, -1.996)));
    e.detection(3, detection(clock(600, '2026-11-28')));
    e.update(4, keyOf(at(1200)), { frp: 99 }); // no closeExpired yet
    expect(e.counters.frozenIgnored).toBe(1);
    expect(e.dets.get(keyOf(at(1200)))!.frp).toBe(5);
  });

  it('gives the same result whether memory is reclaimed after every frame or only at the end', () => {
    const frames: Array<[number, DetOpts]> = [
      [1, at(1200)], [2, at(1205, -1.996)], [3, clock(1500)], [4, at(1000, -1.99)], [5, clock(2300)],
      [6, at(1210, -1.992)], [7, clock(600, '2026-11-28')], [8, at(1220, -1.994)],
    ];
    const run = (eager: boolean) => {
      const e = new FireEngine();
      for (const [offset, o] of frames) {
        e.detection(offset, detection(o));
        if (eager) e.closeExpired(offset);
      }
      e.closeExpired(99);
      return JSON.stringify({ fires: [...e.fires.keys()], c: { ...e.counters, finalizedFires: 0, evictedDetections: 0 }, singles: e.singletons() });
    };
    expect(run(true)).toBe(run(false));
  });

  it('keeps memory bounded over a long stream', () => {
    const e = new FireEngine();
    let offset = 0;
    for (let day = 0; day < 6; day++) {
      for (let i = 0; i < 200; i++) {
        offset++;
        e.detection(offset, detection({ lat: -2 + (i % 20) * 0.5, lon: 110 + Math.floor(i / 20), time: Math.floor((i * 7) / 60) * 100 + ((i * 7) % 60), date: `2026-11-${String(20 + day).padStart(2, '0')}` }));
      }
      e.closeExpired(offset);
    }
    expect(e.dets.size).toBeLessThan(600); // ~1200 detections seen, only the last ~12 h kept
    expect(e.counters.evictedDetections).toBeGreaterThan(0);
  });
});

describe('persisted watermark', () => {
  it('survives a restart: a beyond-bound detection is still rejected and counters carry over', async () => {
    const storage = new InMemoryStorage();
    const first = new FireSink(storage);
    await first.apply([detFrame(1, at(1200)), detFrame(2, clock(1800))], ctx);

    const second = new FireSink(storage);
    await second.apply([detFrame(3, at(1100, -1.996))], ctx);
    expect(second.engine.counters.lateBeyond).toBe(1);

    const third = new FireSink(storage);
    await third.apply([updateFrame(4, keyOf(at(1200)), { frp: 2 })], ctx);
    expect(third.engine.counters.lateBeyond).toBe(1);
    expect(third.engine.stats().watermark).toBe('2026-11-27T12:00:00.000Z');
  });

  it('deletes evicted detection docs and marks the fire finalized in fire_state', async () => {
    const storage = new InMemoryStorage();
    const sink = new FireSink(storage);
    await sink.apply([detFrame(1, at(1200)), detFrame(2, at(1210, -1.996))], ctx);
    const before = (await storage.listDocs('fire_state', { prefix: 'det:', limit: 50 })).items.length;
    await sink.apply([detFrame(3, clock(600, '2026-11-28'))], ctx);

    const dets = (await storage.listDocs('fire_state', { prefix: 'det:', limit: 50 })).items.length;
    const fires = (await storage.listDocs<{ status: string }>('fire_state', { prefix: 'fire:', limit: 50 })).items;
    expect(before).toBe(2);
    expect(dets).toBe(1); // only the far clock detection remains
    expect(fires.map((f) => f.doc.status)).toEqual(['finalized']);
  });
});
