import { describe, expect, it } from 'vitest';
import { fireId } from '../../../../shared-types/src/m2/ids';
import type { Detection } from '../../../../shared-types/src/m2/types';
import { FireEngine } from './engine';
import { detection, keyOf, type DetOpts } from './fixtures';

// 0.005 deg of latitude is ~0.55 km
const A: DetOpts = { lat: -2.0, lon: 110.0 };
const near = (o: DetOpts, dLat: number, extra: Partial<DetOpts> = {}): DetOpts => ({ ...o, lat: o.lat + dLat, ...extra });

function run(steps: Array<[string, DetOpts | string, (Partial<Detection> | undefined)?]>): FireEngine {
  const e = new FireEngine();
  steps.forEach(([kind, arg, changes], i) => {
    const offset = i + 1;
    if (kind === 'd') e.detection(offset, detection(arg as DetOpts));
    else if (kind === 'u') e.update(offset, arg as string, changes!);
    else e.retract(offset, arg as string);
  });
  return e;
}
const fireKeys = (e: FireEngine) => [...e.fires.values()].map((s) => [...s].sort()).sort();

describe('clustering (FIRE-1..5)', () => {
  it('counts a repeated detection once and does not make a fire from a single one', () => {
    const e = run([['d', A], ['d', A], ['d', A]]);
    expect(e.dets.size).toBe(1);
    expect(e.fires.size).toBe(0);
    expect(e.singletons()).toBe(1);
  });

  it('connects detections within 1 km and 360 min, across satellites', () => {
    const e = run([['d', A], ['d', near(A, 0.005, { sat: 'N20' })]]);
    expect(e.fires.size).toBe(1);
    expect(fireKeys(e)[0]).toHaveLength(2);
  });

  it('does not connect beyond 1 km or beyond 360 min', () => {
    expect(run([['d', A], ['d', near(A, 0.011)]]).fires.size).toBe(0); // ~1.2 km
    expect(run([['d', A], ['d', near(A, 0.002, { time: 1800 })]]).fires.size).toBe(1); // exactly 360 min
    expect(run([['d', A], ['d', near(A, 0.002, { time: 1801 })]]).fires.size).toBe(0); // 361 min
  });

  it('chains: A-B and B-C make one fire although A-C is farther than 1 km', () => {
    const e = run([['d', A], ['d', near(A, 0.007)], ['d', near(A, 0.014)]]);
    expect(e.fires.size).toBe(1);
    expect([...e.fires.values()][0].size).toBe(3);
  });

  it('excludes low confidence and lets an update flip eligibility both ways', () => {
    const e = run([['d', A], ['d', near(A, 0.004, { conf: 'l' })]]);
    expect(e.fires.size).toBe(0);
    e.update(10, keyOf(near(A, 0.004, { conf: 'l' })), { confidence: 'h' });
    expect(e.fires.size).toBe(1);
    e.update(11, keyOf(near(A, 0.004, { conf: 'l' })), { confidence: 'l' });
    expect(e.fires.size).toBe(0);
  });

  it('merges two fires through a bridging detection; the smallest key gives the id and the other fire is superseded', () => {
    const left = [A, near(A, 0.004)];
    const right = [near(A, 0.016), near(A, 0.02)];
    const e = run([...left, ...right].map((o) => ['d', o] as ['d', DetOpts]));
    expect(e.fires.size).toBe(2);
    e.takeChanges();
    e.detection(20, detection(near(A, 0.01)));
    expect(e.fires.size).toBe(1);
    const all = [...left, near(A, 0.01), ...right].map(keyOf);
    const id = fireId(all);
    expect(e.fires.has(id)).toBe(true);
    const changes = e.takeChanges();
    expect([...changes.fires.values()].some((c) => c.kind === 'gone' && c.mergedInto === id)).toBe(true);
  });

  it('shrinks below 2 detections -> fire gone; regrows -> the same id returns', () => {
    const b = near(A, 0.004);
    const e = run([['d', A], ['d', b]]);
    const id = [...e.fires.keys()][0];
    e.takeChanges();
    e.retract(10, keyOf(b));
    expect(e.fires.size).toBe(0);
    expect([...e.takeChanges().fires.entries()]).toEqual([[id, { kind: 'gone', offset: 10, mergedInto: undefined }]]);
    e.detection(11, detection(b)); // re-detection after retract resurrects (last writer wins)
    expect([...e.fires.keys()]).toEqual([id]);
  });

  it('handles double retract, update after retract and unknown keys without effect', () => {
    const b = near(A, 0.004);
    const e = run([['d', A], ['d', b]]);
    e.retract(10, keyOf(b));
    e.takeChanges();
    e.retract(11, keyOf(b));
    e.update(12, keyOf(b), { frp: 99 });
    e.update(13, 'N|2026-11-27|1|0.00000|0.00000', { frp: 1 });
    e.retract(14, 'nope');
    expect(e.takeChanges().fires.size).toBe(0);
    expect(e.dets.get(keyOf(b))!.frp).toBe(5);
  });
});

describe('determinism', () => {
  const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const points = (n: number): DetOpts[] => {
    const r = rng(7);
    return Array.from({ length: n }, () => ({ lat: -2 + r() * 0.03, lon: 110 + r() * 0.03, time: 600 + Math.floor(r() * 600), sat: ['N', 'N20', 'N21'][Math.floor(r() * 3)], conf: r() < 0.1 ? 'l' : 'n', frp: Math.round(r() * 3000) / 100 } as DetOpts));
  };
  const fold = (order: DetOpts[], chunk: number): string => {
    const e = new FireEngine();
    order.forEach((o, i) => { if (i % chunk === 0) e.takeChanges(); e.detection(i + 1, detection(o)); });
    return JSON.stringify([...e.fires.entries()].map(([id, ks]) => [id, [...ks].sort()]).sort());
  };

  it('gives identical fires for any arrival order of the same detections', () => {
    const pts = points(80);
    const baseline = fold(pts, 1);
    const r = rng(11);
    for (let i = 0; i < 6; i++) {
      const shuffled = [...pts].sort(() => r() - 0.5);
      expect(fold(shuffled, 1 + i * 7)).toBe(baseline);
    }
    expect(JSON.parse(baseline).length).toBeGreaterThan(0);
  });

  it('is idempotent: re-applying the same frames changes nothing', () => {
    const pts = points(40);
    const e = new FireEngine();
    pts.forEach((o, i) => e.detection(i + 1, detection(o)));
    const before = JSON.stringify([...e.fires.entries()].map(([id, ks]) => [id, [...ks].sort()]).sort());
    e.takeChanges();
    pts.forEach((o, i) => e.detection(i + 1, detection(o)));
    expect(e.takeChanges().fires.size).toBe(0);
    expect(JSON.stringify([...e.fires.entries()].map(([id, ks]) => [id, [...ks].sort()]).sort())).toBe(before);
  });
});
