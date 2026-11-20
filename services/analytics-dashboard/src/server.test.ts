import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { PAGE } from './page';
import { buildDashboard } from './server';

const summary = { by_type_over_time: [{ bucket: '2026-11-17T00:00:00.000Z', gempa: 2, tsunami: 0, gunung_berapi: 1, kebakaran_hutan: 0, pesisir: 0 }], by_severity: { NORMAL: 2, WASPADA: 1, SIAGA: 0, AWAS: 0 }, by_area: [{ area_name: 'Palu', count: 3 }], total: 3, partial: false, unavailable_units: [], as_of: '2026-11-17T03:00:00.000Z' };

async function upstream(handler: (url: string, key: string | undefined) => { status: number; body: unknown }) {
  const seen: Array<{ url: string; key?: string }> = [];
  const srv = createServer((req, res) => {
    const key = req.headers['x-internal-service-key'] as string | undefined;
    seen.push({ url: req.url ?? '', key });
    const r = handler(req.url ?? '', key);
    res.statusCode = r.status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(r.body));
  });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  return { base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, seen, close: () => new Promise<void>((ok) => srv.close(() => ok())) };
}

describe('analytics dashboard', () => {
  it('serves the page with no external resources and no innerHTML', async () => {
    const app = buildDashboard({ aggregatorBaseUrl: 'http://x', internalKey: 'k' });
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<title>Analitik Kebencanaan BNPB</title>');
    // The SVG namespace URI is an identifier, not a fetch; anything else would be an external dependency.
    expect(PAGE.replace('http://www.w3.org/2000/svg', '')).not.toMatch(/https?:\/\//);
    expect(PAGE).not.toContain('innerHTML');
  });

  it('proxies the summary unchanged, forwards the filter and sends the internal key', async () => {
    const up = await upstream(() => ({ status: 200, body: summary }));
    const app = buildDashboard({ aggregatorBaseUrl: up.base, internalKey: 'secret' });
    const res = await app.inject({ method: 'GET', url: '/api/summary?bucket=hour&from=2026-11-17T00:00:00.000Z' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(summary);
    expect(up.seen[0].key).toBe('secret');
    expect(up.seen[0].url).toContain('bucket=hour');
    expect(up.seen[0].url).toContain('from=2026-11-17T00%3A00%3A00.000Z');
    await up.close();
  });

  it('passes the partial marker and unavailable units through so the page can show "belum lengkap"', async () => {
    const up = await upstream(() => ({ status: 200, body: { ...summary, partial: true, unavailable_units: ['storage-unit-1'] } }));
    const res = await buildDashboard({ aggregatorBaseUrl: up.base, internalKey: 'k' }).inject({ method: 'GET', url: '/api/summary' });
    expect(res.json()).toMatchObject({ partial: true, unavailable_units: ['storage-unit-1'] });
    await up.close();
  });

  it('answers 503 in the error envelope when the aggregator is down or errors, never 500', async () => {
    const down = buildDashboard({ aggregatorBaseUrl: 'http://127.0.0.1:1', internalKey: 'k', timeoutMs: 500 });
    const a = await down.inject({ method: 'GET', url: '/api/summary' });
    expect(a.statusCode).toBe(503);
    expect(a.json().error.code).toBe('SERVICE_UNAVAILABLE');

    const up = await upstream(() => ({ status: 500, body: { error: { code: 'X', message: 'boom' } } }));
    const b = await buildDashboard({ aggregatorBaseUrl: up.base, internalKey: 'k' }).inject({ method: 'GET', url: '/api/summary' });
    expect(b.statusCode).toBe(503);
    await up.close();
  });

  it('rejects a bad bucket or timestamp with 400 before calling upstream', async () => {
    const up = await upstream(() => ({ status: 200, body: summary }));
    const app = buildDashboard({ aggregatorBaseUrl: up.base, internalKey: 'k' });
    expect((await app.inject({ method: 'GET', url: '/api/summary?bucket=week' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/summary?from=yesterday' })).statusCode).toBe(400);
    expect(up.seen).toHaveLength(0);
    await up.close();
  });
});
