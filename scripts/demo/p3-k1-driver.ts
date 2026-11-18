import { createHmac } from 'node:crypto';
import { mapVolcanicReportToHazardEvent } from '../../services/aggregator/src/mapping/volcanic-mapper';

const BASE = process.env.PVMBG_URL ?? 'http://127.0.0.1:18082';
const SECRET = process.env.PVMBG_JWT_SECRET ?? '';

const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ aud: 'pvmbg', iat: now, exp: now + 600 })}`;
const token = `${head}.${createHmac('sha256', SECRET).update(head).digest('base64url')}`;

type Row = { kind: string; source: string; declared: string; observed: string };
const rows: Row[] = [];

function classify(record: unknown): string {
  try {
    mapVolcanicReportToHazardEvent(record as never);
    return 'AUTO';
  } catch (err) {
    const e = err as { name?: string; reason_code?: string };
    return e.name === 'SchemaIncompatibleError' ? `PARK ${e.reason_code}` : `CRASH ${String(err)}`;
  }
}

async function fresh(mode: string): Promise<unknown[]> {
  const t0 = new Date().toISOString();
  await fetch(`${BASE}/admin/schema-version`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }) });
  for (let i = 0; i < 60; i++) {
    const res = await fetch(`${BASE}/volcanic-reports?since=${encodeURIComponent(t0)}`, { headers: { authorization: `Bearer ${token}` } });
    const data = ((await res.json()) as { data: unknown[] }).data;
    if (data.length >= 5) return data;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`no fresh records for mode ${mode}`);
}

const MODES: Array<[string, string, string]> = [
  ['baseline (no change)', 'baseline', 'AUTO'],
  ['additive optional field / null / int to float', 'additive', 'AUTO'],
  ['rename (volcano_id)', 'rename', 'PARK SCHEMA_INCOMPATIBLE'],
  ['type change (eruption_count_24h)', 'type_change', 'PARK SCHEMA_INCOMPATIBLE'],
  ['required field dropped (ash_column_height_m)', 'drop_required', 'PARK SCHEMA_INCOMPATIBLE'],
];

(async () => {
  for (const [kind, mode, declared] of MODES) {
    const results = new Set((await fresh(mode)).map(classify));
    rows.push({ kind, source: `mock mode ${mode}`, declared, observed: [...results].join(' | ') });
  }
  await fetch(`${BASE}/admin/schema-version`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'baseline' }) });

  const sample = (await fresh('baseline'))[0] as Record<string, unknown>;
  rows.push({ kind: 'additive enum value', source: 'synthetic record', declared: 'PARK UNKNOWN_ENUM_VALUE', observed: classify({ ...sample, alert_level: 'Siaga-II' }) });
  rows.push({ kind: 'unknown alert_level (narrowing)', source: 'synthetic record', declared: 'PARK UNKNOWN_ENUM_VALUE', observed: classify({ ...sample, alert_level: 'Unknown' }) });
  rows.push({ kind: 'unit change (m to km)', source: 'synthetic record', declared: 'AUTO (not detectable)', observed: classify({ ...sample, ash_column_height_m: 1.2 }) });

  const w = (k: keyof Row) => Math.max(k.length, ...rows.map((r) => r[k].length));
  const line = (r: Row, ok: string) => `${r.kind.padEnd(w('kind'))} | ${r.source.padEnd(w('source'))} | ${r.declared.padEnd(w('declared'))} | ${r.observed.padEnd(w('observed'))} | ${ok}`;
  console.log(line({ kind: 'change kind', source: 'source', declared: 'declared', observed: 'observed' }, 'verdict'));
  let failures = 0;
  for (const r of rows) {
    const ok = r.declared.startsWith(r.observed) || r.observed === r.declared ? 'PASS' : 'FAIL';
    if (ok === 'FAIL') failures++;
    console.log(line(r, ok));
  }
  console.log(failures === 0 ? '\nPASS: system behavior matches the declaration' : `\nFAIL: ${failures} row(s) differ from the declaration`);
  process.exit(failures === 0 ? 0 : 1);
})();
