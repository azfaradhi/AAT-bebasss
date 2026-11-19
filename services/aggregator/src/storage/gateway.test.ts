import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { GatewayStorageClient } from '../../../../shared-types/src/ring/gateway-client';
import { storageConformance } from '../../test-support/contract-fakes/conformance/storage.conformance';
import { InMemoryStorage } from '../../test-support/contract-fakes/fakes/in-memory-storage';
import { registerStorageGateway } from './gateway-route';

function make(key = 'ik') {
  const backing = new InMemoryStorage();
  const app = Fastify({ logger: false });
  registerStorageGateway(app, backing, key);
  const client = new GatewayStorageClient({
    baseUrl: 'http://gateway.test', internalServiceKey: key,
    fetchImpl: async (url, init) => {
      const res = await app.inject({ method: 'POST', url: new URL(url).pathname, headers: init.headers, payload: init.body });
      return { status: res.statusCode, json: async () => (res.body ? JSON.parse(res.body) : null) };
    },
  });
  return { app, backing, client };
}

storageConformance('GatewayStorageClient through the Aggregator gateway', () => {
  const { backing, client } = make();
  return { client, controls: backing };
});

describe('storage gateway', () => {
  it('rejects calls without the internal key and unknown operations', async () => {
    const { app } = make();
    expect((await app.inject({ method: 'POST', url: '/internal/storage/listEvents', payload: { args: [{ limit: 1 }] } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/internal/storage/dropEverything', headers: { 'x-internal-key': 'ik' }, payload: {} })).statusCode).toBe(404);
  });

  it('reports an unreachable gateway as StorageUnavailableError', async () => {
    const client = new GatewayStorageClient({ baseUrl: 'http://x', internalServiceKey: 'k', fetchImpl: async () => { throw new Error('refused'); } });
    await expect(client.outboxPending()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  });
});
