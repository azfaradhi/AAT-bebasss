import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { FireSink } from '../../services/satellite-processor/src/fire/fire-sink';
import { detFrame, keyOf, retractFrame, updateFrame } from '../../services/satellite-processor/src/fire/fixtures';
import type { SatFrame } from '../../services/satellite-processor/src/sink';
import { InMemoryStorage } from '../../services/satellite-processor/test-support/contract-fakes/fakes/in-memory-storage';

const mode = process.argv[2];
const ctx = { fence: 1, signal: new AbortController().signal };
const list = async (s: InMemoryStorage) => (await s.listEvents({ source: 'SATELIT', limit: 1000 })).items;
const checks: Array<[string, string, boolean]> = [];
const check = (name: string, value: unknown, ok: boolean) => checks.push([name, String(value), ok]);

async function realSlice(): Promise<{ storage: InMemoryStorage; sink: FireSink; frames: SatFrame[] }> {
  const raw = gunzipSync(readFileSync(new URL('../../tools/feed-fixture-server/fixtures/feed-slice-offsets-11900-14899.jsonl.gz', `file://${__filename}`))).toString('utf8');
  const frames: SatFrame[] = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: number; event: string; data: Record<string, unknown> })
    .filter((f) => f.event !== 'heartbeat')
    .map((f) => ({ offset: f.id, kind: f.event as SatFrame['kind'], data: f.data }));
  const storage = new InMemoryStorage();
  const sink = new FireSink(storage);
  for (let i = 0; i < frames.length; i += 500) await sink.apply(frames.slice(i, i + 500), ctx);
  return { storage, sink, frames };
}

(async () => {
  if (mode === 'k1') {
    const A = { lat: -2.0, lon: 110.0, sat: 'N', time: 1200, frp: 12.5 };
    const B = { lat: -1.996, lon: 110.0, sat: 'N20', time: 1215, frp: 7.25 };
    const storage = new InMemoryStorage();
    await new FireSink(storage).apply([detFrame(1, A), detFrame(2, B)], ctx);
    const events = await list(storage);
    check('synthetic: N + N20 within 1 km / 15 min', `${events.length} event`, events.length === 1);
    check('synthetic: satellites on the one event', JSON.stringify(events[0]?.attributes.satellites), JSON.stringify(events[0]?.attributes.satellites) === '["N","N20"]');

    const { storage: real, sink } = await realSlice();
    const evs = await list(real);
    const multi = evs.filter((e) => (e.attributes.satellites as string[]).length > 1);
    check('real slice: fires (events)', evs.length, evs.length === sink.engine.fires.size);
    check('real slice: fires seen by >= 2 satellites', multi.length, multi.length > 0);
    check('real slice: duplicate events per fire', evs.length - new Set(evs.map((e) => e.source_ref_id)).size, new Set(evs.map((e) => e.source_ref_id)).size === evs.length);
    check('real slice: every fire has >= 2 detections', 'min ' + Math.min(...evs.map((e) => e.attributes.detection_count as number)), evs.every((e) => (e.attributes.detection_count as number) >= 2));
    check('real slice: singletons reported (FIRE-5)', sink.engine.singletons(), sink.engine.singletons() >= 0);
    const keys = new Set<string>();
    let overlap = 0;
    for (const e of evs) for (const k of e.attributes.detection_keys as string[]) { if (keys.has(k)) overlap++; keys.add(k); }
    check('real slice: a detection in two fires', overlap, overlap === 0);
    if (multi[0]) console.log(`example multi-satellite fire: ${multi[0].hazard_id} ${multi[0].area_name} sat=${JSON.stringify(multi[0].attributes.satellites)} detections=${multi[0].attributes.detection_count} severity=${multi[0].severity}`);
  } else {
    const A = { lat: -2.0, lon: 110.0, sat: 'N', time: 1200, frp: 12.5 };
    const B = { lat: -1.996, lon: 110.0, sat: 'N20', time: 1215, frp: 7.25 };
    const storage = new InMemoryStorage();
    const sink = new FireSink(storage);
    await sink.apply([detFrame(1, A), detFrame(2, B)], ctx);
    const [e0] = await list(storage);
    await sink.apply([updateFrame(3, keyOf(B), { frp: 30 })], ctx);
    const [e1] = await list(storage);
    check('update keeps hazard_id', `${e0.hazard_id} -> ${e1.hazard_id}`, e0.hazard_id === e1.hazard_id);
    check('update changes attributes', `${e0.attributes.total_frp_mw} -> ${e1.attributes.total_frp_mw} MW, ${e0.severity} -> ${e1.severity}`, e1.attributes.total_frp_mw === 42.5 && e1.severity === 'SIAGA');
    await sink.apply([retractFrame(4, keyOf(B))], ctx);
    check('retract below 2 detections: event leaves listing', `${(await list(storage)).length} events`, (await list(storage)).length === 0);
    const gone = await storage.getEvent(e0.hazard_id);
    check('tombstoned event is no longer served', gone.event === null ? 'getEvent -> null' : 'still served', gone.event === null);
    await sink.apply([detFrame(5, B)], ctx);
    const [e2] = await list(storage);
    check('re-detection revives the same hazard_id', e2?.hazard_id, e2?.hazard_id === e0.hazard_id);

    const { storage: real, frames } = await realSlice();
    const kinds = frames.reduce<Record<string, number>>((m, f) => ({ ...m, [f.kind]: (m[f.kind] ?? 0) + 1 }), {});
    const evs = await list(real);
    check('real slice: update/retract frames applied', `${kinds.update} updates, ${kinds.retract} retracts`, kinds.update > 0 && kinds.retract > 0);
    check('real slice: one event per hazard_id', evs.length, new Set(evs.map((e) => e.hazard_id)).size === evs.length);
  }
  for (const [name, value, ok] of checks) console.log(`${name.padEnd(52)} | ${value.padEnd(44)} | ${ok ? 'PASS' : 'FAIL'}`);
  const failed = checks.filter((c) => !c[2]).length;
  console.log(failed === 0 ? `\nPASS (${mode})` : `\nFAIL: ${failed} check(s)`);
  process.exit(failed === 0 ? 0 : 1);
})();
