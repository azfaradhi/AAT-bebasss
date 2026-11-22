// P1-L3: how the partition-key alternatives behave on the K2 workloads, measured with the same two workloads as p1-surge-e2e.ts
// (3000 events over 8 regions and 72 hours; 3000 events from ONE region within one hour) and the real Ring class. Pure computation, no processes.
import { createHash } from 'node:crypto';
import { hazardId } from '../../shared-types/src/m2/ids';
import { Ring } from '../../shared-types/src/ring/ring';

const h32 = (s: string) => createHash('sha256').update(s).digest().readUInt32BE(0);
const AREAS = ['Aceh', 'Sumut', 'Jabar', 'Jateng', 'NTT', 'Sulteng', 'Maluku', 'Papua'];
interface Ev { id: string; area: string; hour: number }
const dataset: Ev[] = Array.from({ length: 3000 }, (_, i) => ({ id: hazardId('BMKG', `ds-${i}`), area: AREAS[i % AREAS.length], hour: Math.floor((i * 72) / 3000) }));
const burst: Ev[] = Array.from({ length: 3000 }, (_, i) => ({ id: hazardId('BMKG', `burst-${i}`), area: 'Palu, Sulawesi Tengah', hour: 5 }));

type Place = (e: Ev, n: number) => number;
const strategies: Array<[string, Place]> = [
  ['by region (hash(area) mod N)', (e, n) => h32(e.area) % n],
  ['by time (hour bucket mod N)', (e, n) => e.hour % n],
  ['hash(id) mod N', (e, n) => h32(e.id) % n],
];
const ringPlace = (vnodes: number): Place => {
  const rings = new Map<number, Ring>();
  return (e, n) => { if (!rings.has(n)) rings.set(n, new Ring(Array.from({ length: n }, (_, i) => `unit-${i}`), 2, vnodes)); return Number(rings.get(n)!.replicas(e.id)[0].split('-')[1]); };
};
strategies.push(['consistent hashing, 1 vnode/unit', ringPlace(1)], ['consistent hashing, 64 vnodes/unit (ours)', ringPlace(64)], ['consistent hashing, 256 vnodes/unit', ringPlace(256)]);

const share = (evs: Ev[], p: Place, n: number) => { const c = Array(n).fill(0); for (const e of evs) c[p(e, n)]++; return c as number[]; };
const spread = (c: number[]) => ((Math.max(...c) - Math.min(...c)) / (c.reduce((a, b) => a + b, 0) / c.length)) * 100;
const moved = (p: Place) => dataset.filter((e) => p(e, 3) !== p(e, 4)).length / dataset.length * 100;

const out: string[] = ['# P1-L3: partition-key alternatives on the K2 workloads (3 units; spread = (max-min)/mean of writes per unit; moved = share of keys whose primary changes when a 4th unit joins)', '# command: npx --prefix services/aggregator tsx scripts/demo/p1-alternatives-measure.ts'];
out.push(`${'strategy'.padEnd(44)} ${'dataset (3 units)'.padEnd(22)} ${'one-region burst'.padEnd(22)} moved on 3->4`);
for (const [name, p] of strategies) {
  const d = share(dataset, p, 3), b = share(burst, p, 3);
  out.push(`${name.padEnd(44)} ${(d.join('/') + ` ${spread(d).toFixed(0)}%`).padEnd(22)} ${(b.join('/') + ` ${spread(b).toFixed(0)}%`).padEnd(22)} ${moved(p).toFixed(0)}%`);
}
process.stdout.write(out.join('\n') + '\n');
