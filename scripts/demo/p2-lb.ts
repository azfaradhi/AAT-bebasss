// Multi-worker HTTP Load Balancer / Entry Point for Aggregator instances (P2-K1, P2-K6, P2-K7, P2-K8).
// Uses node:cluster so the LB itself scales across CPU cores and is never a single-core bottleneck during k6 benchmarks.
// Continuously health-checks /ready on all registered backends, immediately stops routing to non-ready backends,
// and retries idempotent GET requests if a backend connection drops mid-flight during scaling or rolling update.
import cluster from 'node:cluster';
import http from 'node:http';

export interface BackendSpec {
  id: string;
  url: string;
  node: string;
  version: string;
}

interface BackendState extends BackendSpec {
  healthy: boolean;
}

const PORT = Number(process.env.LB_PORT ?? 19300);
const WORKERS = Number(process.env.LB_WORKERS ?? 4);
const HEALTH_INTERVAL_MS = Number(process.env.LB_HEALTH_INTERVAL_MS ?? 120);

function parseInitialBackends(): BackendState[] {
  const raw = process.env.LB_BACKENDS ?? '';
  if (!raw) return [];
  return raw.split(',').filter(Boolean).map((item, idx) => {
    const [url, id = `aggregator-${idx + 1}`, node = `node-${idx % 3}`, version = 'v1'] = item.split('|');
    return { id, url, node, version, healthy: true };
  });
}

if (cluster.isPrimary && WORKERS > 1) {
  let backends: BackendState[] = parseInitialBackends();
  const stats = {
    totalRequests: 0,
    byInstance: {} as Record<string, number>,
    byVersion: {} as Record<string, number>,
    unhealthySkipped: 0,
    retriedRequests: 0,
  };

  const broadcastBackends = () => {
    for (const id in cluster.workers) {
      cluster.workers[id]?.send({ type: 'backends', backends });
    }
  };

  // Primary runs the fast /ready health checker and broadcasts healthy backend table to all workers
  const failCounts = new Map<string, number>();
  const checkHealth = async () => {
    await Promise.all(
      backends.map(async (b) => {
        try {
          const res = await fetch(`${b.url}/ready`, { signal: AbortSignal.timeout(1500) });
          if (res.status === 200) {
            failCounts.set(b.id, 0);
            b.healthy = true;
          } else {
            // Explicit 503 not_ready (e.g. draining) immediately marks unhealthy
            b.healthy = false;
          }
        } catch {
          const c = (failCounts.get(b.id) ?? 0) + 1;
          failCounts.set(b.id, c);
          if (c >= 2) b.healthy = false;
        }
      }),
    );
    broadcastBackends();
  };
  setInterval(() => void checkHealth(), HEALTH_INTERVAL_MS).unref();

  for (let i = 0; i < WORKERS; i++) {
    const w = cluster.fork();
    w.on('message', (msg: any) => {
      if (msg?.type === 'stat') {
        stats.totalRequests += 1;
        if (msg.instance) stats.byInstance[msg.instance] = (stats.byInstance[msg.instance] ?? 0) + 1;
        if (msg.version) stats.byVersion[msg.version] = (stats.byVersion[msg.version] ?? 0) + 1;
        if (msg.retried) stats.retriedRequests += 1;
      } else if (msg?.type === 'set_backends') {
        backends = (msg.backends as BackendSpec[]).map((b) => ({ ...b, healthy: true }));
        void checkHealth().then(() => broadcastBackends());
        broadcastBackends();
      } else if (msg?.type === 'get_status' && w.isConnected()) {
        w.send({ type: 'status_reply', reqId: msg.reqId, backends, stats });
      }
    });
  }
} else {
  let backends: BackendState[] = parseInitialBackends();
  let rr = Math.floor(Math.random() * 100);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1024, maxFreeSockets: 256, keepAliveMsecs: 30_000 });
  const pendingStatus = new Map<string, (data: any) => void>();

  if (cluster.isWorker) {
    process.on('message', (msg: any) => {
      if (msg?.type === 'backends') {
        backends = msg.backends;
      } else if (msg?.type === 'status_reply') {
        const fn = pendingStatus.get(msg.reqId);
        if (fn) {
          pendingStatus.delete(msg.reqId);
          fn({ backends: msg.backends, stats: msg.stats });
        }
      }
    });
  } else {
    // Single-process mode health loop
    setInterval(async () => {
      await Promise.all(
        backends.map(async (b) => {
          try {
            const res = await fetch(`${b.url}/ready`, { signal: AbortSignal.timeout(400) });
            b.healthy = res.status === 200;
          } catch {
            b.healthy = false;
          }
        }),
      );
    }, HEALTH_INTERVAL_MS).unref();
  }

  const localStats = {
    totalRequests: 0,
    byInstance: {} as Record<string, number>,
    byVersion: {} as Record<string, number>,
    retriedRequests: 0,
  };

  const proxyOnce = (target: BackendState, req: http.IncomingMessage, bodyBuf: Buffer): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> =>
    new Promise((resolve, reject) => {
      const u = new URL(req.url ?? '/', target.url);
      const outReq = http.request(
        {
          hostname: u.hostname,
          port: u.port,
          path: u.pathname + u.search,
          method: req.method,
          headers: { ...req.headers, host: u.host },
          agent,
          timeout: 4000,
        },
        (outRes) => {
          const chunks: Buffer[] = [];
          outRes.on('data', (c) => chunks.push(c));
          outRes.on('end', () => resolve({ status: outRes.statusCode ?? 502, headers: outRes.headers, body: Buffer.concat(chunks) }));
          outRes.on('error', reject);
        },
      );
      outReq.on('timeout', () => {
        outReq.destroy(new Error('backend timeout'));
      });
      outReq.on('error', reject);
      if (bodyBuf.length > 0) outReq.write(bodyBuf);
      outReq.end();
    });

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const bodyBuf = Buffer.concat(chunks);

    if (req.url === '/lb/status' && req.method === 'GET') {
      if (cluster.isWorker && process.send) {
        const reqId = `${process.pid}-${Date.now()}-${Math.random()}`;
        const data = await new Promise<any>((r) => {
          pendingStatus.set(reqId, r);
          process.send!({ type: 'get_status', reqId });
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ backends, stats: localStats }));
      return;
    }

    if (req.url === '/lb/backends' && req.method === 'POST') {
      const parsed = JSON.parse(bodyBuf.toString('utf8')) as { backends: BackendSpec[] };
      backends = parsed.backends.map((b) => ({ ...b, healthy: true }));
      if (cluster.isWorker && process.send) {
        process.send({ type: 'set_backends', backends: parsed.backends });
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, count: backends.length }));
      return;
    }

    const healthy = backends.filter((b) => b.healthy);
    if (healthy.length === 0) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: 'No healthy aggregator instances' } }));
      return;
    }

    let lastErr: unknown = null;
    let retried = false;
    const maxAttempts = Math.min(healthy.length, 3);
    const startIdx = rr++;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const candidate = healthy[(startIdx + attempt) % healthy.length];
      try {
        const out = await proxyOnce(candidate, req, bodyBuf);
        // If backend just started draining (returned 503 on /ready or internal route), retry another healthy backend
        if (out.status >= 502 && attempt + 1 < maxAttempts) {
          if (healthy.length > 1) candidate.healthy = false;
          retried = true;
          continue;
        }
        const inst = String(out.headers['x-aggregator-instance'] ?? candidate.id);
        const ver = String(out.headers['x-aggregator-version'] ?? candidate.version);
        localStats.totalRequests += 1;
        localStats.byInstance[inst] = (localStats.byInstance[inst] ?? 0) + 1;
        localStats.byVersion[ver] = (localStats.byVersion[ver] ?? 0) + 1;
        if (retried) localStats.retriedRequests += 1;
        if (cluster.isWorker && process.send) {
          process.send({ type: 'stat', instance: inst, version: ver, retried });
        }
        res.writeHead(out.status, {
          ...out.headers,
          'x-aggregator-instance': inst,
          'x-aggregator-version': ver,
          'x-lb-node': candidate.node,
        });
        res.end(out.body);
        return;
      } catch (err) {
        lastErr = err;
        if (healthy.length > 1) candidate.healthy = false;
        retried = true;
      }
    }

    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: String(lastErr ?? 'upstream failed') } }));
  });

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.listen(PORT, '127.0.0.1', 4096);
}
