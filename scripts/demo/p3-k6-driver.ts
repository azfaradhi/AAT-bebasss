import { createHmac } from 'node:crypto';
import { FieldReportStore } from '../../shared-types/src/field-reports';
import { InMemoryStorage } from '../../services/field-report-processor/test-support/contract-fakes/fakes/in-memory-storage';
import { buildOpsApp } from '../../services/client-api/src/routes/ops-app';

const N = Number(process.env.N ?? 500);
const REPEAT_RATE = 0.24;
const SECRET = 'demo-client-secret';
const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
const token = (() => {
  const now = Math.floor(Date.now() / 1000);
  const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'lapangan-client', scope: 'lapangan', aud: 'bnpb-client', purpose: 'access', iat: now, exp: now + 3600 })}`;
  return `${head}.${createHmac('sha256', SECRET).update(head).digest('base64url')}`;
})();

let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

// Storage whose writes can be made to "crash" the calling process at chosen points.
const real = new InMemoryStorage();
let crash: ((op: string, key: string) => boolean) | null = null;
const storage = new Proxy(real, {
  get(target, prop, receiver) {
    if (prop === 'putDoc' || prop === 'deleteDoc') {
      return async (...args: unknown[]) => {
        if (crash?.(String(prop), String(args[1]))) throw new Error('simulated crash');
        return (target as never as Record<string, (...a: unknown[]) => unknown>)[prop as string](...args);
      };
    }
    const value = Reflect.get(target, prop, receiver);
    return typeof value === 'function' ? value.bind(target) : value;
  },
}) as unknown as InMemoryStorage;

// A "fresh receiver pod": no state survives between requests except the ring.
const freshReceiver = () => buildOpsApp({ jwtSecret: SECRET, aggregatorBaseUrl: 'http://x', internalServiceKey: 'k', fieldReportStore: new FieldReportStore(storage) });
const body = (i: number) => ({ category: 'KORBAN', description: `laporan ${i}`, latitude: -2 + (i % 7) * 0.1, longitude: 110, observed_at: '2026-11-17T01:00:00Z' });

(async () => {
  const keys: string[] = [];
  const acked = new Map<string, number>(); // key -> times answered 202
  const ackedIds = new Set<string>();
  const latencies: number[] = [];
  let crashedReceivers = 0;
  let crashRetriesThatFoundExisting = 0;
  let repeatRequests = 0;

  // phase 1: processor paused entirely while reports arrive; the receiver "dies" after every 202 (fresh instance per request)
  // and, for 8% of new reports, between the report write and the pending-marker write (the client then retries with the same key)
  for (let i = 0; i < N; i++) {
    const isRepeat = keys.length > 10 && rnd() < REPEAT_RATE;
    const key = isRepeat ? keys[Math.floor(rnd() * keys.length)] : `key-${i}`;
    if (!isRepeat) keys.push(key);
    else repeatRequests++;
    const willCrash = !isRepeat && rnd() < 0.08;
    let attempts = 0;
    for (;;) {
      attempts++;
      crash = willCrash && attempts === 1 ? (op, k) => op === 'putDoc' && k.startsWith('p:') : null;
      const started = performance.now();
      let status: number;
      let reportId = '';
      try {
        const res = (await freshReceiver().inject({
          method: 'POST', url: '/field-reports', payload: body(i),
          headers: { authorization: `Bearer ${token}`, 'idempotency-key': key, 'x-correlation-id': `req-${i}-${attempts}` },
        }));
        status = res.statusCode;
        if (status === 202) reportId = res.json().report_id;
      } catch { status = 599; }
      crash = null;
      if (status === 202) { latencies.push(performance.now() - started); acked.set(key, (acked.get(key) ?? 0) + 1); ackedIds.add(reportId); break; }
      crashedReceivers++;
      if (attempts > 5) throw new Error(`request ${i} never accepted`);
    }
    if (willCrash && attempts > 1) crashRetriesThatFoundExisting++;
  }

  const store = (): FieldReportStore => new FieldReportStore(storage);
  const mid = await store().audit({ limit: 1 });

  // phase 2: the processor comes back and keeps getting killed mid-processing (after marking, before clearing the marker, and mid-batch)
  let processorKills = 0;
  for (let round = 0; round < 200; round++) {
    let writes = 0;
    crash = rnd() < 0.7 ? () => ++writes === 1 + Math.floor(rnd() * 4) : null;
    try { await store().sweep(1, 25); } catch { processorKills++; }
    crash = null;
    if ((await store().audit({ limit: 1 })).processed_total === keys.length) break;
  }
  await store().sweep(1, 1000); // a final healthy sweep clears leftover markers
  const audit = await store().audit({ limit: 1 });
  const stored = new Set((await store().audit({ limit: 10_000 })).items);
  const lost = [...ackedIds].filter((id) => !stored.has(id)).length;
  const extra = [...stored].filter((id) => !ackedIds.has(id)).length;

  latencies.sort((a, b) => a - b);
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  const unique = keys.length;
  const expectedDuplicates = repeatRequests + crashRetriesThatFoundExisting;
  const markers = (await real.listDocs('field_reports', { prefix: 'p:', limit: 10 })).items.length;
  const rows: Array<[string, string, boolean]> = [
    ['requests sent / unique Idempotency-Keys', `${N} / ${unique}`, true],
    ['receiver crashed before 202 (client retried)', String(crashedReceivers), true],
    ['accepted_total == unique keys', `${audit.accepted_total} == ${unique}`, audit.accepted_total === unique],
    ['processed_total == accepted_total (while paused: ' + mid.processed_total + ')', `${audit.processed_total} == ${audit.accepted_total}`, audit.processed_total === audit.accepted_total && mid.processed_total === 0],
    ['duplicates_dropped_total == repeats + crash retries', `${audit.duplicates_dropped_total} == ${repeatRequests} + ${crashRetriesThatFoundExisting}`, audit.duplicates_dropped_total === expectedDuplicates],
    ['processor killed mid-processing', `${processorKills} times`, processorKills > 0],
    ['every 202 report is stored; nothing stored that was not 202d', `lost ${lost}, extra ${extra}, ids ${ackedIds.size}`, lost === 0 && extra === 0 && ackedIds.size === unique],
    ['leftover pending markers', String(markers), markers === 0],
    ['202 latency p95 while the processor was paused', `${p95.toFixed(2)} ms`, p95 < 50],
  ];
  for (const [name, value, ok] of rows) console.log(`${name.padEnd(62)} | ${value.padEnd(28)} | ${ok ? 'PASS' : 'FAIL'}`);
  const failed = rows.filter((r) => !r[2]).length;
  console.log(failed === 0 ? '\nPASS: no 202 report lost, none processed twice, duplicates counted exactly' : `\nFAIL: ${failed} check(s)`);
  process.exit(failed === 0 ? 0 : 1);
})();
