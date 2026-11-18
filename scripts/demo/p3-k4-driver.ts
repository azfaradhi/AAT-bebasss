import { createHash, createHmac } from 'node:crypto';
import { createIngestContext, createReplayApp, storageClientWriter } from '../../services/aggregator/src/ingest';
import { mapVolcanicReportToHazardEvent } from '../../services/aggregator/src/mapping/volcanic-mapper';
import { CircuitBreaker } from '../../services/aggregator/src/resilience/circuit-breaker';
import { ConcurrencyLimiter } from '../../services/aggregator/src/resilience/concurrency-limiter';
import { PvmbgClient } from '../../services/aggregator/src/sources/pvmbg-client';
import { InMemoryStorage } from '../../services/aggregator/test-support/contract-fakes/fakes/in-memory-storage';
import { hazardId } from '../../shared-types/src/m2/ids';

const BASE = process.env.PVMBG_URL ?? 'http://127.0.0.1:18082';
const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ aud: 'pvmbg', iat: now, exp: now + 900 })}`;
const token = `${head}.${createHmac('sha256', process.env.PVMBG_JWT_SECRET ?? '').update(head).digest('base64url')}`;
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined } as never;

const setMode = (mode: string) => fetch(`${BASE}/admin/schema-version`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Creates exactly n reports in the current mode (no live timer involved, so the counts are deterministic).
async function fresh(since: string, n: number): Promise<Array<Record<string, unknown>>> {
  await fetch(`${BASE}/admin/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ count: n }) });
  const res = await fetch(`${BASE}/volcanic-reports?since=${encodeURIComponent(since)}`, { headers: { authorization: `Bearer ${token}` } });
  return ((await res.json()) as { data: Array<Record<string, unknown>> }).data;
}

(async () => {
  const storage = new InMemoryStorage();
  const ingest = createIngestContext({ storage, env: {} });
  const writer = storageClientWriter(storage, ingest);
  const client = (mapperVersion: 'v1' | 'v2') => new PvmbgClient({
    baseUrl: BASE, accessToken: token, timeoutMs: 10_000, logger: quiet, ingest, mapperVersion,
    circuitBreaker: new CircuitBreaker(1000, 1000), limiter: new ConcurrencyLimiter(1),
  });
  const ingestNow = async (events: Awaited<ReturnType<PvmbgClient['poll']>>) => {
    for (const e of events) await writer.write({ ...e, hazard_id: hazardId('PVMBG', e.source_ref_id), ingested_at: new Date().toISOString() }, 'poll');
  };

  const seen: Array<{ id: string; mode: string }> = [];
  for (const [mode, n] of [['baseline', 8], ['rename', 6], ['type_change', 6], ['drop_required', 4]] as const) {
    await setMode(mode);
    const since = new Date().toISOString();
    const records = await fresh(since, n);
    for (const r of records) seen.push({ id: String(r.report_id), mode });
    await ingestNow(await client('v1').poll(since)); // mapper v1 (the declared policy)
  }
  await setMode('baseline');

  const events = async () => (await storage.listEvents({ limit: 1000 })).items.filter((e) => e.source === 'PVMBG');
  const reasons = async () => {
    const items = (await ingest.parker.listUnprocessed({ limit: 1000 })).items;
    return items.reduce<Record<string, number>>((m, p) => ({ ...m, [p.reason_code]: (m[p.reason_code] ?? 0) + 1 }), {});
  };
  const phase = (m: string) => seen.filter((s) => s.mode === m).length;
  const rows: Array<[string, string, boolean]> = [];
  const check = (name: string, value: string, ok: boolean) => rows.push([name, value, ok]);

  const parkedBefore = await reasons();
  const storedBefore = (await events()).length;
  const totalParked = Object.values(parkedBefore).reduce((a, b) => a + b, 0);
  console.log(`before replay: stored ${storedBefore}, parked ${JSON.stringify(parkedBefore)}`);
  check('records seen / stored by v1 / parked', `${seen.length} / ${storedBefore} / ${totalParked}`, storedBefore + totalParked === seen.length);

  // "deploy" mapper v2: replay endpoint wired with the v2 mapper
  const app = createReplayApp({ ingest, writer, mapperVersion: 'v2' }, 'k');
  const replay = async () => (await app.inject({ method: 'POST', url: '/internal/ops/replay', headers: { 'x-internal-key': 'k' }, payload: {} })).json();

  const report = await replay();
  console.log(`replay #1: ${JSON.stringify(report)}`);
  const unrecoverable = phase('drop_required');
  const stored = await events();
  const ids = stored.map((e) => e.source_ref_id);
  const expectedIds = seen.filter((s) => s.mode !== 'drop_required').map((s) => s.id).sort();
  check('parked before -> recovered / still failing', `${totalParked} -> ${report.recovered} / ${report.still_failing}`, report.recovered === phase('rename') + phase('type_change') && report.still_failing === unrecoverable);
  check('stored events == expected set (all but dropped field)', `${ids.length} of ${expectedIds.length}`, JSON.stringify([...ids].sort()) === JSON.stringify(expectedIds));
  check('duplicate events', String(ids.length - new Set(ids).size), ids.length === new Set(ids).size);
  check('still parked = dropped required field (cannot be mapped)', JSON.stringify(await reasons()), (await reasons()).SCHEMA_INCOMPATIBLE === unrecoverable);

  // fault-free reference: the same raw records mapped straight through v2, no parking, in a fresh store
  const ref = new InMemoryStorage();
  const refWriter = storageClientWriter(ref, createIngestContext({ storage: ref, env: {} }));
  const all = await fetch(`${BASE}/volcanic-reports`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json() as Promise<{ data: Array<Record<string, unknown>> }>);
  const wanted = new Set(expectedIds);
  for (const r of all.data) {
    if (!wanted.has(String(r.report_id))) continue;
    const e = mapVolcanicReportToHazardEvent(r as never, 'v2');
    await refWriter.write({ ...e, hazard_id: hazardId('PVMBG', e.source_ref_id), ingested_at: 'x' }, 'ref');
  }
  const digest = (es: Array<{ hazard_id: string; severity: string; area_name: string; attributes: object; occurred_at: string }>) =>
    createHash('sha256').update(JSON.stringify(es.map((e) => [e.hazard_id, e.severity, e.area_name, e.occurred_at, e.attributes]).sort())).digest('hex').slice(0, 16);
  const refEvents = (await ref.listEvents({ limit: 1000 })).items.filter((e) => e.source === 'PVMBG');
  check('content digest vs fault-free run', `${digest(stored)} vs ${digest(refEvents)}`, digest(stored) === digest(refEvents));

  const before = JSON.stringify(stored);
  const again = await replay();
  console.log(`replay #2: ${JSON.stringify(again)}`);
  check('second replay changes nothing', `considered ${again.considered}, recovered ${again.recovered}`, again.recovered === 0 && JSON.stringify(await events()) === before);

  for (const [name, value, ok] of rows) console.log(`${name.padEnd(58)} | ${value.padEnd(40)} | ${ok ? 'PASS' : 'FAIL'}`);
  const failed = rows.filter((r) => !r[2]).length;
  console.log(failed === 0 ? '\nPASS: all recoverable messages recovered, no duplicates, replay is idempotent' : `\nFAIL: ${failed} check(s)`);
  process.exit(failed === 0 ? 0 : 1);
})();
