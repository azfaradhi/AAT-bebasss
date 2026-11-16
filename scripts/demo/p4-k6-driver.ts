import { writeFileSync, mkdirSync } from 'node:fs';
import { FireSink } from '../../services/satellite-processor/src/fire/fire-sink';
import type { SatFrame } from '../../services/satellite-processor/src/sink';
import { InMemoryStorage } from '../../services/satellite-processor/test-support/contract-fakes/fakes/in-memory-storage';
import { referenceFires, type Frame, type RefFire } from '../verify/p4-reference-batch';

const FEED = process.env.FEED_URL ?? 'http://127.0.0.1:18102';
const OUT = process.env.OUT_DIR ?? '/tmp/p4-k6';
const LATENESS_MIN = Number(process.env.LATENESS_MIN ?? 360);

interface Diff { fire: string; field: string; pipeline: unknown; reference: unknown; cause: string }

(async () => {
  mkdirSync(OUT, { recursive: true });
  const frames = (await (await fetch(`${FEED}/admin/frames`)).json()) as Frame[];
  const ring = new InMemoryStorage();
  const sink = new FireSink(ring, Date.now, LATENESS_MIN * 60_000);
  const satFrames: SatFrame[] = frames.filter((f) => f.event !== 'heartbeat').map((f) => ({ offset: f.id, kind: f.event as SatFrame['kind'], data: f.data }));
  for (let i = 0; i < satFrames.length; i += 500) await sink.apply(satFrames.slice(i, i + 500), { fence: 1, signal: new AbortController().signal });
  const events = (await ring.listEvents({ source: 'SATELIT', limit: 100_000 })).items;
  const pipe = new Map(events.map((e) => [e.source_ref_id, e]));
  const ref = referenceFires(frames);
  const refMap = new Map(ref.fires.map((f) => [f.source_ref_id, f]));
  const late = new Set(sink.engine.lateLog.map((l) => l.key));
  const stats = sink.engine.stats();

  const diffs: Diff[] = [];
  const allKeys = (e: { attributes: unknown }) => (e.attributes as { detection_keys: string[] }).detection_keys;
  const pipeFireOfKey = new Map<string, string>();
  for (const [id, p] of pipe) for (const k of allKeys(p)) pipeFireOfKey.set(k, id);
  const matched = new Set<string>();
  const LATE = 'lateness bound (detections beyond the allowed lateness are counted, not merged)';
  for (const [refId, r] of refMap) {
    // match by shared detections, not by id: an id derives from the smallest key, which may be a beyond-bound detection
    const votes = new Map<string, number>();
    for (const k of r.detection_keys) { const pid = pipeFireOfKey.get(k); if (pid) votes.set(pid, (votes.get(pid) ?? 0) + 1); }
    const pid = [...votes.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0];
    const droppedLate = r.detection_keys.filter((k) => late.has(k));
    if (!pid) { diffs.push({ fire: refId, field: 'fire missing in pipeline', pipeline: null, reference: r.detection_count, cause: droppedLate.length ? LATE : 'unexplained' }); continue; }
    matched.add(pid);
    const p = pipe.get(pid)!;
    const a = p.attributes as Record<string, unknown>;
    const missing = r.detection_keys.filter((k) => !(a.detection_keys as string[]).includes(k));
    const extra = (a.detection_keys as string[]).filter((k) => !r.detection_keys.includes(k));
    const explained = missing.length > 0 && missing.every((k) => late.has(k)) && extra.length === 0;
    const cause = missing.length === 0 && extra.length === 0 ? 'unexplained' : explained ? LATE : 'unexplained';
    const cmp = (field: string, pv: unknown, rv: unknown, why: string) => { if (JSON.stringify(pv) !== JSON.stringify(rv)) diffs.push({ fire: refId, field, pipeline: pv, reference: rv, cause: why }); };
    cmp('hazard_id / fire id', pid, refId, explained ? `${LATE}; the smallest key was beyond the bound, so the id derives from another key` : 'unexplained');
    cmp('detection_count', a.detection_count, r.detection_count, cause);
    cmp('detection_keys', a.detection_keys, r.detection_keys, cause);
    cmp('severity', p.severity, r.severity, cause);
    cmp('area_name', p.area_name, r.area_name, cause);
    cmp('occurred_at', p.occurred_at, r.occurred_at, cause);
    cmp('satellites', a.satellites, r.satellites, cause);
    cmp('max_confidence', a.max_confidence, r.max_confidence, cause);
    const near = (x: number, y: number) => Math.abs(x - y) <= 0.01;
    for (const [fld, pv, rv] of [['total_frp_mw', a.total_frp_mw, r.total_frp_mw], ['latitude', p.latitude, r.latitude], ['longitude', p.longitude, r.longitude]] as Array<[string, number, number]>) {
      if (pv !== rv) diffs.push({ fire: refId, field: fld, pipeline: pv, reference: rv, cause: explained ? cause : near(pv, rv) ? 'rounding (float sums vs integer hundredths)' : 'unexplained' });
    }
  }
  for (const [id, p] of pipe) {
    if (matched.has(id)) continue;
    diffs.push({ fire: id, field: 'extra fire in pipeline', pipeline: allKeys(p).length, reference: null, cause: 'unexplained' });
  }
  const byCause = diffs.reduce<Record<string, number>>((m, d) => ({ ...m, [d.cause]: (m[d.cause] ?? 0) + 1 }), {});
  const unexplained = diffs.filter((d) => d.cause === 'unexplained').length;

  const report = {
    stream: { frames: frames.length, distinct_detections: ref.stored, retracted: ref.retracted, eligible: ref.eligible },
    allowed_lateness_min: LATENESS_MIN,
    fires: { pipeline: pipe.size, reference: refMap.size },
    singles: { pipeline_total: stats.singles_total, reference: ref.singles },
    beyond_bound_detections: stats.lateBeyond, frozen_updates_ignored: stats.frozenIgnored,
    differences: diffs.length, by_cause: byCause, unexplained,
    examples: diffs.slice(0, 8),
  };
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2) + '\n');
  writeFileSync(`${OUT}/pipeline-fires.json`, JSON.stringify([...pipe.values()].map(({ ingested_at: _i, ...e }) => e), null, 1));
  writeFileSync(`${OUT}/reference-fires.json`, JSON.stringify(ref.fires as RefFire[], null, 1));
  console.log(JSON.stringify(report, null, 2));

  const rows: Array<[string, string, boolean]> = [
    ['fire count pipeline vs reference', `${pipe.size} vs ${refMap.size}`, LATENESS_MIN >= 360 ? pipe.size === refMap.size : true],
    ['single detections (FIRE-5) pipeline vs reference', `${stats.singles_total} vs ${ref.singles}`, LATENESS_MIN >= 360 ? stats.singles_total === ref.singles : true],
    ['every difference has an explained cause', `${diffs.length} differences, ${unexplained} unexplained`, unexplained === 0],
    ['no difference at the declared lateness bound (360 min)', `${diffs.length}`, LATENESS_MIN < 360 || diffs.length === 0],
  ];
  for (const [name, value, ok] of rows) console.log(`${name.padEnd(54)} | ${value.padEnd(40)} | ${ok ? 'PASS' : 'FAIL'}`);
  const failed = rows.filter((r) => !r[2]).length;
  console.log(failed === 0 ? '\nPASS' : `\nFAIL: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})();
