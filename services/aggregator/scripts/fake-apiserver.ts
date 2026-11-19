// Dev apiserver: Lease and ConfigMap REST paths with resourceVersion compare-and-swap, for failover demos without a cluster.
import Fastify from 'fastify';
import { FakeKube } from '../../../shared-types/src/coordination/fake-kube';
import { KubeConflictError } from '../../../shared-types/src/coordination/kube-api';

const kube = new FakeKube();
const app = Fastify({ logger: false });
const ns = process.env.LEASE_NAMESPACE ?? 'default';
const leases = `/apis/coordination.k8s.io/v1/namespaces/${ns}/leases`;
const maps = `/api/v1/namespaces/${ns}/configmaps`;
const lease = (l: { name: string; resourceVersion: string; holder: string | null; transitions: number }) => ({ metadata: { name: l.name, resourceVersion: l.resourceVersion }, spec: { holderIdentity: l.holder, leaseTransitions: l.transitions } });
const cmap = (m: { name: string; resourceVersion: string; data: Record<string, string> }) => ({ metadata: { name: m.name, resourceVersion: m.resourceVersion }, data: m.data });
const guard = async (reply: { code(n: number): { send(b: unknown): unknown } }, fn: () => Promise<unknown>) => {
  try { return await fn(); } catch (e) { return e instanceof KubeConflictError ? reply.code(409).send({ reason: 'Conflict' }) : reply.code(500).send({}); }
};

app.get<{ Params: { n: string } }>(`${leases}/:n`, async (q, r) => { const l = await kube.getLease(q.params.n); return l ? lease(l) : r.code(404).send({}); });
app.post<{ Body: any }>(leases, async (q, r) => guard(r, async () => lease(await kube.createLease(q.body.metadata.name, q.body.spec.holderIdentity))));
app.put<{ Params: { n: string }; Body: any }>(`${leases}/:n`, async (q, r) => guard(r, async () => lease(await kube.updateLease(q.params.n, q.body.metadata.resourceVersion, q.body.spec.holderIdentity, q.body.spec.leaseTransitions))));
app.get<{ Params: { n: string } }>(`${maps}/:n`, async (q, r) => { const m = await kube.getConfigMap(q.params.n); return m ? cmap(m) : r.code(404).send({}); });
app.post<{ Body: any }>(maps, async (q, r) => guard(r, async () => cmap(await kube.createConfigMap(q.body.metadata.name, q.body.data))));
app.put<{ Params: { n: string }; Body: any }>(`${maps}/:n`, async (q, r) => guard(r, async () => cmap(await kube.updateConfigMap(q.params.n, q.body.metadata.resourceVersion, q.body.data))));

app.listen({ port: Number(process.env.KUBE_API_PORT ?? 18130), host: '127.0.0.1' }).catch((e) => { process.stderr.write(`${e}\n`); process.exit(1); });
