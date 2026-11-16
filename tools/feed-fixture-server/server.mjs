import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const DEFAULT_FIXTURE = new URL('./fixtures/feed-slice-offsets-11900-14899.jsonl.gz', import.meta.url);

const shiftDate = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

// `repeat` > 1 chains copies of the slice into one long stream (offsets keep counting, every copy is one day later), so a
// 60x burst of the size of the real backlog (~108k frames) can be replayed deterministically from the 3 000 committed frames.
export function loadFrames(path = DEFAULT_FIXTURE, repeat = 1) {
  const raw = readFileSync(path);
  const text = String(path).endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
  const base = text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  if (repeat <= 1) return base;
  const span = base[base.length - 1].id - base[0].id + 1;
  const frames = [];
  for (let c = 0; c < repeat; c++) {
    for (const f of base) {
      if (c === 0) { frames.push(f); continue; }
      const data = { ...f.data, offset: f.id + c * span };
      if (data.detection) data.detection = { ...data.detection, acq_date: shiftDate(data.detection.acq_date, c) };
      if (typeof data.key === 'string') { const p = data.key.split('|'); p[1] = shiftDate(p[1], c); data.key = p.join('|'); }
      frames.push({ id: f.id + c * span, event: f.event, data });
    }
  }
  return frames;
}

const envelope = (res, status, code, message) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { code, message } }));
};

// Replays captured frames like the real feed: shared offsets, one connection at a time, inclusive from= / exclusive Last-Event-ID.
export function startFixtureServer(opts = {}) {
  const frames = opts.frames ?? loadFrames(opts.fixturePath, opts.repeat ?? 1);
  const fps = opts.framesPerSecond ?? Infinity;
  const token = opts.token ?? null;
  const stats = { connections: 0, rejected: 0, framesSent: 0, starts: [] };
  let active = null;
  let disconnectEveryN = opts.disconnectEveryN ?? 0;
  let closeAfterMs = opts.closeAfterMs ?? 0;

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/admin/stats') return json(res, { ...stats, active: !!active });
    if (url.pathname === '/admin/info') return json(res, { first_id: frames[0].id, last_id: frames[frames.length - 1].id, total: frames.length });
    if (url.pathname === '/admin/frames') return json(res, frames);
    if (url.pathname === '/admin/disconnect' && req.method === 'POST') {
      const had = !!active;
      active?.destroy();
      return json(res, { disconnected: had });
    }
    if (url.pathname === '/admin/config' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const cfg = JSON.parse(body || '{}');
        if ('disconnectEveryN' in cfg) disconnectEveryN = cfg.disconnectEveryN;
        if ('closeAfterMs' in cfg) closeAfterMs = cfg.closeAfterMs;
        json(res, { disconnectEveryN, closeAfterMs });
      });
      return;
    }
    if (token && req.headers.authorization !== `Bearer ${token}`) return envelope(res, 401, 'unauthorized', 'token tidak valid');
    if (url.pathname === '/v1/session') {
      return json(res, { profile: 'fixture', speed: 60, group: 'fixture', latest_offset: frames[frames.length - 1].id, virtual_now: new Date().toISOString() });
    }
    if (url.pathname !== '/v1/stream') return envelope(res, 404, 'not_found', 'route tidak ditemukan');

    const fromParam = url.searchParams.get('from');
    const lastEventId = req.headers['last-event-id'];
    let start = frames[0].id;
    if (fromParam !== null) {
      if (!/^\d+$/.test(fromParam)) return envelope(res, 400, 'bad_request', 'parameter from tidak valid');
      start = Number(fromParam);
    } else if (typeof lastEventId === 'string' && /^\d+$/.test(lastEventId)) {
      start = Number(lastEventId) + 1;
    }
    if (active) {
      stats.rejected++;
      return envelope(res, 429, 'too_many_connections', 'koneksi aktif lain ditutup; sambung ulang');
    }

    stats.connections++;
    stats.starts.push(start);
    active = res;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    let index = frames.findIndex((f) => f.id >= start);
    if (index < 0) index = frames.length;
    let sentThisConnection = 0;
    let timer = null;
    const finish = () => { clearTimeout(timer); clearTimeout(lifetime); if (active === res) active = null; };
    res.on('close', finish);
    const lifetime = closeAfterMs ? setTimeout(() => res.end(), closeAfterMs) : null;

    const pump = () => {
      if (res.destroyed || res.writableEnded) return;
      if (index >= frames.length) return res.end();
      const batch = Number.isFinite(fps) ? Math.max(1, Math.round(fps / 100)) : 200; // paced in ~10 ms ticks
      for (let i = 0; i < batch && index < frames.length; i++) {
        const f = frames[index++];
        res.write(`id: ${f.id}\nevent: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`);
        stats.framesSent++;
        sentThisConnection++;
        if (disconnectEveryN && sentThisConnection >= disconnectEveryN) return res.destroy();
      }
      timer = setTimeout(pump, Number.isFinite(fps) ? (batch * 1000) / fps : 0);
    };
    pump();
  });

  const json = (res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve({
      port: server.address().port,
      url: `http://127.0.0.1:${server.address().port}`,
      stats,
      firstId: frames[0].id,
      lastId: frames[frames.length - 1].id,
      frames,
      disconnect: () => active?.destroy(),
      close: () => new Promise((done) => { active?.destroy(); server.close(() => done()); }),
    }));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startFixtureServer({
    port: Number(process.env.PORT ?? 8099),
    frames: process.env.FRAMES_FILE ? loadFrames(process.env.FRAMES_FILE) : undefined,
    repeat: Number(process.env.REPEAT_CYCLES ?? 1),
    framesPerSecond: process.env.FRAMES_PER_SECOND ? Number(process.env.FRAMES_PER_SECOND) : Infinity,
    disconnectEveryN: Number(process.env.DISCONNECT_EVERY_N ?? 0),
    closeAfterMs: Number(process.env.CLOSE_AFTER_MS ?? 0),
    token: process.env.FIXTURE_TOKEN ?? null,
  });
  console.log(`feed-fixture-server listening on ${s.url} (offsets ${s.firstId}..${s.lastId})`);
}
