import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { bindCorrelationId } from './correlationId';
import { currentCorrelationId } from '../context';

function app() {
  const a = Fastify({ logger: false });
  a.addHook('onRequest', bindCorrelationId);
  a.get('/x', async () => ({ bound: currentCorrelationId() }));
  return a;
}

describe('bindCorrelationId', () => {
  it('generates and echoes a correlation id when none is given', async () => {
    const res = await app().inject({ method: 'GET', url: '/x' });
    expect(res.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.json().bound).toBe(res.headers['x-correlation-id']);
  });

  it('reuses an inbound X-Correlation-ID', async () => {
    const res = await app().inject({ method: 'GET', url: '/x', headers: { 'x-correlation-id': 'given-id' } });
    expect(res.headers['x-correlation-id']).toBe('given-id');
    expect(res.json().bound).toBe('given-id');
  });
});
