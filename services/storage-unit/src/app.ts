import Fastify, { type FastifyInstance } from 'fastify';
import { FencedError, type UnitState } from '../../../shared-types/src/m2/types';
import { registerHttpMetrics } from '../../../shared-types/src/obs-lite';
import type { UnitCtx, UnitDump, UnitOutboxSpec, UnitRow } from '../../../shared-types/src/ring/protocol';
import { UnitEngine } from './engine';

const STATES: UnitState[] = ['STABLE', 'JOINING', 'RECOVERING', 'DOWN'];
type Q = Record<string, string | undefined>;

export function buildUnitApp(engine: UnitEngine): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 * 1024 });
  const httpMetrics = registerHttpMetrics(app, 'storage-unit');

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof FencedError) return reply.code(409).send({ code: 'FENCED', fence_name: err.fenceName, got: err.got, current: err.current });
    return reply.code(500).send({ code: 'INTERNAL', message: err instanceof Error ? err.message : 'error' });
  });

  const identity = () => ({ unit: engine.unit, node: engine.node, state: engine.state });
  app.get('/u/identity', async () => identity());
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/ready', async (_req, reply) => (engine.state === 'DOWN' ? reply.code(503).send({ status: 'down' }) : { status: 'ready' }));
  app.get('/metrics', async (_req, reply) => {
    const st = engine.stats();
    const pendingCount = engine.pending().length;
    const extra = [
      `# TYPE bnpb_storage_unit_up gauge`,
      `bnpb_storage_unit_up{node="${engine.node}",unit="${engine.unit}"} ${engine.state === 'STABLE' ? 1 : 0}`,
      `# TYPE bnpb_unit_keys gauge`,
      `bnpb_unit_keys{node="${engine.node}",unit="${engine.unit}"} ${st.keys}`,
      `# TYPE bnpb_unit_writes_total counter`,
      `bnpb_unit_writes_total{node="${engine.node}",unit="${engine.unit}"} ${st.writes_total}`,
      `# TYPE bnpb_outbox_pending gauge`,
      `bnpb_outbox_pending{node="${engine.node}",unit="${engine.unit}"} ${pendingCount}`,
    ].join('\n') + '\n';
    return reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8').send(httpMetrics.render() + extra);
  });
  app.post<{ Body: { state: UnitState } }>('/u/state', async (req, reply) => {
    if (!STATES.includes(req.body?.state)) return reply.code(400).send({ code: 'BAD_REQUEST' });
    engine.state = req.body.state;
    return identity();
  });
  app.get('/u/stats', async () => engine.stats());

  app.post<{ Body: { row: UnitRow; ctx: UnitCtx; outbox?: UnitOutboxSpec } }>('/u/events', async (req) => engine.upsert(req.body.row, req.body.ctx, req.body.outbox));
  app.post<{ Body: { hazard_id: string; version: number; merged_into?: string; ctx: UnitCtx } }>('/u/events/tombstone', async (req) =>
    engine.tombstone(req.body.hazard_id, req.body.version, req.body.ctx, req.body.merged_into));
  app.get<{ Querystring: Q }>('/u/events', async (req) => ({
    rows: engine.list({ source: req.query.source, hazardType: req.query.hazard_type, since: req.query.since, afterT: req.query.after_t, afterH: req.query.after_h, limit: Number(req.query.limit ?? 100) }),
  }));
  app.get<{ Querystring: Q }>('/u/scan', async (req) => ({ rows: engine.scan(req.query.source) }));
  app.get<{ Params: { id: string } }>('/u/events/:id', async (req) => ({ row: engine.get(req.params.id) }));

  app.put<{ Params: { c: string; key: string }; Body: { doc: unknown; version?: number; ctx: UnitCtx } }>('/u/docs/:c/:key', async (req) =>
    engine.putDoc(req.params.c, req.params.key, req.body.doc, req.body.ctx, req.body.version));
  app.get<{ Params: { c: string; key: string } }>('/u/docs/:c/:key', async (req) => ({ entry: engine.getDoc(req.params.c, req.params.key) }));
  app.post<{ Params: { c: string; key: string }; Body: { ctx: UnitCtx } }>('/u/docs/:c/:key/delete', async (req) => {
    engine.deleteDoc(req.params.c, req.params.key, req.body.ctx);
    return { ok: true };
  });
  app.get<{ Params: { c: string }; Querystring: Q }>('/u/docs/:c', async (req) => ({
    entries: engine.listDocs(req.params.c, { prefix: req.query.prefix, after: req.query.after, limit: Number(req.query.limit ?? 100) }),
  }));

  app.post<{ Body: { max: number; leaseMs: number } }>('/u/outbox/claim', async (req) => ({ items: engine.claim(req.body.max, req.body.leaseMs) }));
  app.post<{ Body: { ids: string[] } }>('/u/outbox/published', async (req) => { engine.markPublished(req.body.ids); return { ok: true }; });
  app.get('/u/outbox/pending', async () => ({ ids: engine.pending() }));

  app.post<{ Body: { name: string; token: number } }>('/u/fence', async (req) => { engine.raiseFence(req.body.name, req.body.token); return { ok: true }; });
  app.get('/u/dump', async () => engine.dump());
  app.post<{ Body: UnitDump }>('/u/apply', async (req) => { engine.apply(req.body); return { ok: true }; });

  return app;
}
