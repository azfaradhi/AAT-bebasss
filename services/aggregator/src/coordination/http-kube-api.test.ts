import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeKube } from '../../../../shared-types/src/coordination/fake-kube';
import { HttpKubeApi } from '../../../../shared-types/src/coordination/http-kube-api';
import { LeaseCoordinator } from '../../../../shared-types/src/coordination/lease-coordinator';
import { KubeConflictError } from '../../../../shared-types/src/coordination/kube-api';

const apps: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => { for (const a of apps.splice(0)) await a.close(); });

// A tiny apiserver speaking the Lease and ConfigMap REST paths, backed by the compare-and-swap fake.
async function apiserver() {
  const kube = new FakeKube();
  const app = Fastify({ logger: false });
  const ns = '/apis/coordination.k8s.io/v1/namespaces/bnpb/leases';
  const cm = '/api/v1/namespaces/bnpb/configmaps';
  const toLease = (l: { name: string; resourceVersion: string; holder: string | null; transitions: number }) => ({ metadata: { name: l.name, resourceVersion: l.resourceVersion }, spec: { holderIdentity: l.holder, leaseTransitions: l.transitions } });
  const wrap = async (reply: any, fn: () => Promise<unknown>) => { try { return await fn(); } catch (e) { return e instanceof KubeConflictError ? reply.code(409).send({ reason: 'Conflict' }) : reply.code(500).send({}); } };
  app.get<{ Params: { n: string } }>(`${ns}/:n`, async (req, reply) => { const l = await kube.getLease(req.params.n); return l ? toLease(l) : reply.code(404).send({}); });
  app.post<{ Body: any }>(ns, async (req, reply) => wrap(reply, async () => toLease(await kube.createLease(req.body.metadata.name, req.body.spec.holderIdentity))));
  app.put<{ Params: { n: string }; Body: any }>(`${ns}/:n`, async (req, reply) => wrap(reply, async () => toLease(await kube.updateLease(req.params.n, req.body.metadata.resourceVersion, req.body.spec.holderIdentity, req.body.spec.leaseTransitions))));
  app.get<{ Params: { n: string } }>(`${cm}/:n`, async (req, reply) => { const m = await kube.getConfigMap(req.params.n); return m ? { metadata: { name: m.name, resourceVersion: m.resourceVersion }, data: m.data } : reply.code(404).send({}); });
  app.post<{ Body: any }>(cm, async (req, reply) => wrap(reply, async () => { const m = await kube.createConfigMap(req.body.metadata.name, req.body.data); return { metadata: { name: m.name, resourceVersion: m.resourceVersion }, data: m.data }; }));
  app.put<{ Params: { n: string }; Body: any }>(`${cm}/:n`, async (req, reply) => wrap(reply, async () => { const m = await kube.updateConfigMap(req.params.n, req.body.metadata.resourceVersion, req.body.data); return { metadata: { name: m.name, resourceVersion: m.resourceVersion }, data: m.data }; }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  apps.push(app);
  const addr = app.server.address();
  return new HttpKubeApi({ baseUrl: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`, namespace: 'bnpb' });
}

describe('HttpKubeApi against an apiserver-shaped server', () => {
  it('creates, reads and compare-and-swaps a lease', async () => {
    const api = await apiserver();
    expect(await api.getLease('l')).toBeNull();
    const a = await api.createLease('l', 'pod-a');
    expect(a).toMatchObject({ holder: 'pod-a', transitions: 1 });
    await expect(api.createLease('l', 'pod-b')).rejects.toBeInstanceOf(KubeConflictError);
    const b = await api.updateLease('l', a.resourceVersion, 'pod-b', 2);
    expect(b).toMatchObject({ holder: 'pod-b', transitions: 2 });
    await expect(api.updateLease('l', a.resourceVersion, 'pod-c', 3)).rejects.toBeInstanceOf(KubeConflictError);
    expect((await api.updateLease('l', b.resourceVersion, null, 2)).holder).toBeNull();
  });

  it('stores and compare-and-swaps a config map', async () => {
    const api = await apiserver();
    const m = await api.createConfigMap('c', { state: '1' });
    await expect(api.updateConfigMap('c', 'stale', { state: '2' })).rejects.toBeInstanceOf(KubeConflictError);
    const n = await api.updateConfigMap('c', m.resourceVersion, { state: '2' });
    expect((await api.getConfigMap('c'))!.data.state).toBe('2');
    expect(n.resourceVersion).not.toBe(m.resourceVersion);
  });

  it('drives a LeaseCoordinator end to end over HTTP', async () => {
    const api = await apiserver();
    const c = new LeaseCoordinator({ kube: api, identity: 'pod-a', leaseDurationMs: 200, renewIntervalMs: 30, retryIntervalMs: 10 });
    let fence = 0;
    const run = c.runAsLeader('http', async (ctx) => { fence = ctx.fence; });
    for (let i = 0; i < 100 && !fence; i++) await new Promise((r) => setTimeout(r, 10));
    expect(fence).toBe(1);
    const r0 = await c.readCursor('http');
    expect(await c.commitCursor('http', r0.version, { position: 7, last_ingested_at: null, updated_by: 'a' }, fence)).toBe(true);
    expect((await c.readCursor<number>('http')).state?.position).toBe(7);
    await c.stop(); await run;
    expect((await api.getLease('http'))!.holder).toBeNull();
  });
});
