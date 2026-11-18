import { createHmac } from 'node:crypto';
import { createIngestContext } from '../../services/aggregator/src/ingest';
import { CircuitBreaker } from '../../services/aggregator/src/resilience/circuit-breaker';
import { ConcurrencyLimiter } from '../../services/aggregator/src/resilience/concurrency-limiter';
import { PvmbgClient } from '../../services/aggregator/src/sources/pvmbg-client';
import { InMemoryStorage } from '../../services/aggregator/test-support/contract-fakes/fakes/in-memory-storage';

const BASE = process.env.PVMBG_URL ?? 'http://127.0.0.1:18082';
const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ aud: 'pvmbg', iat: now, exp: now + 600 })}`;
const token = `${head}.${createHmac('sha256', process.env.PVMBG_JWT_SECRET ?? '').update(head).digest('base64url')}`;

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined } as never;
const ingest = createIngestContext({ storage: new InMemoryStorage(), env: {} });
const client = new PvmbgClient({
  baseUrl: BASE, accessToken: token, timeoutMs: 30_000, logger, ingest,
  circuitBreaker: new CircuitBreaker(1000, 1000), limiter: new ConcurrencyLimiter(1),
});

const setCase = (c: string | null) => fetch(`${BASE}/admin/fuzz`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ case: c }) });

// expected: parked reason(s) for the whole response, or the number of healthy events and parked records for a batch
const CASES: Array<{ name: string; reason?: string; healthy?: number; parkedItems?: number }> = [
  { name: 'truncated_json', reason: 'MALFORMED_JSON' },
  { name: 'deep_nesting', reason: 'NESTING_TOO_DEEP' },
  { name: 'invalid_utf8', reason: 'INVALID_UTF8' },
  { name: 'huge_body', reason: 'PAYLOAD_TOO_LARGE' },
  { name: 'empty_body', reason: 'MALFORMED_JSON' },
  { name: 'wrong_content_type', reason: 'MALFORMED_JSON' },
  { name: 'nul_bytes', reason: 'MALFORMED_JSON' },
  { name: 'bom', healthy: 1, parkedItems: 0 },
  { name: 'mixed_batch', healthy: 2, parkedItems: 4 },
];

(async () => {
  const lines: string[] = [];
  let failures = 0;
  for (const c of CASES) {
    const known = new Set((await ingest.parker.listUnprocessed({ limit: 1000 })).items.map((m) => m.message_id));
    await setCase(c.name);
    const started = Date.now();
    let healthy = 0;
    let error = '';
    try {
      healthy = (await client.poll()).length;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const newest = (await ingest.parker.listUnprocessed({ limit: 1000 })).items.filter((m) => !known.has(m.message_id));
    const added = newest.length;
    let ok: boolean;
    let observed: string;
    if (c.reason) {
      ok = added === 1 && newest[0]?.reason_code === c.reason && newest[0].retryable === false && error.includes('response parked');
      observed = `parked 1 as ${newest[0]?.reason_code ?? 'none'}, poll failed cleanly`;
    } else {
      ok = healthy === c.healthy && added === c.parkedItems && !error;
      observed = `${healthy} healthy stored, ${added} parked (${newest.map((n) => n.reason_code).join(',') || '-'})`;
    }
    if (!ok) failures++;
    lines.push(`${c.name.padEnd(20)} | ${(c.reason ?? `${c.healthy} healthy + ${c.parkedItems} parked`).padEnd(26)} | ${observed.padEnd(60)} | ${String(Date.now() - started).padStart(5)} ms | ${ok ? 'PASS' : 'FAIL'}`);
  }
  await setCase(null);
  const baseline = (await client.poll()).length;
  const alive = await fetch(`${BASE}/ready`).then((r) => r.ok).catch(() => false);
  const baselineOk = baseline >= 20 && alive;
  if (!baselineOk) failures++;
  lines.push(`${'baseline after fuzz'.padEnd(20)} | ${'>= 20 healthy'.padEnd(26)} | ${`${baseline} healthy stored, mock alive=${alive}`.padEnd(60)} | ${''.padStart(5)}    | ${baselineOk ? 'PASS' : 'FAIL'}`);

  const all = (await ingest.parker.listUnprocessed({ limit: 1000 })).items;
  lines.push(`\nlistUnprocessed total: ${all.length} (reasons: ${[...new Set(all.map((a) => a.reason_code))].join(', ')})`);
  console.log(['case                 | declared                   | observed                                                     | time     | verdict', ...lines].join('\n'));
  console.log(`rss after run: ${Math.round(process.memoryUsage().rss / 1048576)} MiB, driver process still alive`);
  console.log(failures === 0 ? '\nPASS: every hostile input was parked or absorbed, healthy messages still stored' : `\nFAIL: ${failures} case(s) differ`);
  process.exit(failures === 0 ? 0 : 1);
})();
