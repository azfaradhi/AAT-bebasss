// P3-K6 on the cluster: POST /field-reports answers 202 fast, and no 202'd report is lost or processed twice while the receiving pod is killed.
//   usage: node scripts/cluster/drills/p3-field-reports.mjs      env: REPORTS=150 RETRIES=20
import { Evidence, audit, clientToken, expose, kubectl, p95, secret, sleep, timed, until } from './lib.mjs';

const N = Number(process.env.REPORTS ?? 150), RETRIES = Number(process.env.RETRIES ?? 20);
const ev = new Evidence('P3/K6', 'cluster-p3-field-reports', `P3-K6: ${N} field reports (+${RETRIES} client retries) while the field-report-processor and a client-api pod are deleted`);
const aggregator = expose('aggregator', 8090), client = expose('client-api', 8080), auth = expose('auth-service', 8091);
const A = audit(aggregator);
const tok = await clientToken(auth, 'lapangan');
const before = await A.fieldReports();
const keys = [], codes = [], ms = [];
const send = async (key) => { const r = await timed(`${client}/field-reports`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ category: 'KERUSAKAN', description: `drill ${key}`, latitude: -6.2, longitude: 106.8, observed_at: new Date().toISOString() }) }, 8000); codes.push(r.status); ms.push(r.ms); return r; };
const stamp = Date.now();
for (let i = 0; i < N; i++) {
  const key = `k6drill-${stamp}-${i}`;
  const r = await send(key);
  if (r.status === 202) keys.push(key);
  if (i < RETRIES) { const again = await send(key); if (again.status !== 202) codes.push(again.status); }
  if (i === Math.floor(N * 0.3)) { kubectl(['delete', 'pod', '-l', 'app=field-report-processor', '--grace-period=0', '--force'], { allowFail: true }); ev.log(`field-report-processor deleted after report ${i}`); }
  if (i === Math.floor(N * 0.6)) { const p = kubectl(['get', 'pods', '-l', 'app=client-api', '-o', 'jsonpath={.items[0].metadata.name}']); kubectl(['delete', 'pod', p, '--grace-period=0', '--force'], { allowFail: true }); ev.log(`client-api pod ${p} deleted after report ${i}`); }
  await sleep(150);
}
const not202 = codes.filter((c) => c !== 202);
ev.log(`sent ${codes.length} requests; 202: ${codes.length - not202.length}; other: ${[...new Set(not202)].join(',') || 'none'}; p95 ${p95(ms).toFixed(0)} ms`);
const final = await until('all processed', async () => { const f = await A.fieldReports(); return f.processed_total >= f.accepted_total ? f : null; }, 180_000, 3000).catch(() => null);
const f = final ?? (await A.fieldReports());
ev.log(`audit field-reports: accepted ${before.accepted_total} -> ${f.accepted_total}, processed ${f.processed_total}, duplicates_dropped ${f.duplicates_dropped_total}`);
ev.check('every report answered 202 is stored (accepted grew by the number of unique 202d keys)', f.accepted_total - before.accepted_total === keys.length, `${f.accepted_total - before.accepted_total} vs ${keys.length}`);
ev.check('every accepted report is processed exactly once (processed == accepted, nothing pending)', !!final && f.processed_total === f.accepted_total);
ev.check(`client retries were counted as duplicates, not stored twice (>= ${RETRIES - 2})`, f.duplicates_dropped_total - before.duplicates_dropped_total >= RETRIES - 2);
ev.check('202 answered quickly (p95 < 2000 ms) even while pods were being killed', p95(ms) < 2000, `${p95(ms).toFixed(0)} ms`);
ev.done();
