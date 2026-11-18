import { createHmac } from 'node:crypto';
import { createIngestContext, createUnprocessedApp } from '../../services/aggregator/src/ingest';
import { InMemoryStorage } from '../../services/aggregator/test-support/contract-fakes/fakes/in-memory-storage';
import { buildOpsApp } from '../../services/client-api/src/routes/ops-app';

const SECRET = 'demo-client-secret';
const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
function clientToken(scope: string): string {
  const now = Math.floor(Date.now() / 1000);
  const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: `${scope}-client`, scope, aud: 'bnpb-client', purpose: 'access', iat: now, exp: now + 600 })}`;
  return `${head}.${createHmac('sha256', SECRET).update(head).digest('base64url')}`;
}

(async () => {
  const ingest = createIngestContext({ storage: new InMemoryStorage(), env: {} });
  const park = (code: Parameters<typeof ingest.parker.park>[0]['reason_code'], n: number) =>
    ingest.parker.park({ source: 'PVMBG', raw: Buffer.from(`{"n":${n}}`), reason_code: code, detail: `case ${n}`, orderingKey: `k${n}` }, ingest.writeCtx(`k${n}`));
  await park('SCHEMA_INCOMPATIBLE', 1);
  await park('DOWNSTREAM_UNAVAILABLE', 2);
  await park('MALFORMED_JSON', 3);

  const aggregator = createUnprocessedApp({ parker: ingest.parker, auditToken: 'audit-demo', internalServiceKey: 'svc-demo' });
  await aggregator.listen({ port: 0, host: '127.0.0.1' });
  const aggUrl = `http://127.0.0.1:${(aggregator.server.address() as { port: number }).port}`;
  const ops = buildOpsApp({ jwtSecret: SECRET, aggregatorBaseUrl: aggUrl, internalServiceKey: 'svc-demo' });
  await ops.listen({ port: 0, host: '127.0.0.1' });
  const opsUrl = `http://127.0.0.1:${(ops.server.address() as { port: number }).port}`;

  const rows: Array<[string, number, number, string]> = [];
  const probe = async (label: string, url: string, headers: Record<string, string>, expected: number, note = '') => {
    const res = await fetch(url, { headers });
    rows.push([label, expected, res.status, note || (res.status === 200 ? 'body ok' : 'rejected')]);
    return res;
  };

  await probe('GET /ops/unprocessed  media token', `${opsUrl}/ops/unprocessed`, { authorization: `Bearer ${clientToken('media')}` }, 403);
  await probe('GET /ops/unprocessed  lapangan token', `${opsUrl}/ops/unprocessed`, { authorization: `Bearer ${clientToken('lapangan')}` }, 403);
  const internal = await probe('GET /ops/unprocessed  internal token', `${opsUrl}/ops/unprocessed`, { authorization: `Bearer ${clientToken('internal')}` }, 200);
  const opsBody = (await internal.json()) as { items: Array<{ status: string; raw_sha256?: string }> };
  rows.push(['  internal body has raw metadata', 1, opsBody.items.every((i) => i.raw_sha256) ? 1 : 0, `${opsBody.items.length} items`]);
  await probe('GET /ops/unprocessed  no token', `${opsUrl}/ops/unprocessed`, {}, 401);

  const audit = await probe('GET /internal/audit/unprocessed  audit token', `${aggUrl}/internal/audit/unprocessed`, { authorization: 'Bearer audit-demo' }, 200);
  const items = ((await audit.json()) as { items: Array<{ status: string; retryable: boolean }> }).items;
  const statuses = [...new Set(items.map((i) => i.status))].sort();
  rows.push(['  audit lists both retrying and parked', 1, statuses.join(',') === 'parked,retrying' ? 1 : 0, statuses.join(' + ')]);
  await probe('GET /internal/audit/unprocessed  wrong token', `${aggUrl}/internal/audit/unprocessed`, { authorization: 'Bearer nope' }, 401);

  for (const [label, expected, got, note] of rows) console.log(`${label.padEnd(52)} expected ${String(expected).padEnd(3)} got ${String(got).padEnd(3)} ${note.padEnd(14)} ${expected === got ? 'PASS' : 'FAIL'}`);
  const failed = rows.filter((r) => r[1] !== r[2]).length;
  console.log(failed === 0 ? '\nPASS: media 403, lapangan 403, internal 200; audit token lists retrying and parked' : `\nFAIL: ${failed}`);
  await ops.close();
  await aggregator.close();
  process.exit(failed === 0 ? 0 : 1);
})();
