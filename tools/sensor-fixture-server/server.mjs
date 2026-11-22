// Our own stand-in for the Sensor Pantai API (Lampiran C contract), NOT the assistants' image: /healthz, /v1/stations, /v1/observations with an opaque cursor.
// It serves a deterministic list in which every 10th item violates the contract in one of six ways, every 15th valid item is critical.
// /admin/expected lists what a correct poller must store/park; /admin/request-log shows who called (X-Aggregator-Instance); /admin/outage?ms=N answers 503 for N ms.
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8099);
const TOKEN = process.env.SENSOR_TOKEN ?? 'tok';
const TOTAL = Number(process.env.TOTAL ?? 300);
const PAGE = Number(process.env.PAGE_SIZE ?? 20);

const STATIONS = [
  { station_id: 'stn-padang-01', name: 'Padang', province: 'Sumatera Barat', latitude: -0.95, longitude: 100.35 },
  { station_id: 'stn-cilacap-01', name: 'Cilacap', province: 'Jawa Tengah', latitude: -7.73, longitude: 109.01 },
  { station_id: 'stn-palu-01', name: 'Palu', province: 'Sulawesi Tengah', latitude: -0.9, longitude: 119.87 },
  { station_id: 'stn-ambon-01', name: 'Ambon', province: 'Maluku', latitude: -3.7, longitude: 128.18 },
];
const pad = (n) => String(n).padStart(6, '0');
const startedAt = Date.now();

// Item i (1-based). Violations: wrong type, unknown station, bad quality, negative wave, impossible sea level, conflicting duplicate of the previous id.
function item(i) {
  const st = STATIONS[i % STATIONS.length];
  const base = {
    observation_id: `obs-${pad(i)}`, station_id: st.station_id, observed_at: new Date(startedAt - 5000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    sea_level_anomaly_m: Number(((i % 13) / 10).toFixed(2)), wave_height_m: Number((1 + (i % 7) / 4).toFixed(2)), quality: 'ok', critical: false,
  };
  if (i % 10 === 0) {
    switch ((i / 10) % 6) {
      case 0: return { ...base, wave_height_m: 'tinggi' };
      case 1: return { ...base, station_id: 'stn-tidak-ada' };
      case 2: return { ...base, quality: 'degraded' };
      case 3: return { ...base, wave_height_m: -3 };
      case 4: return { ...base, sea_level_anomaly_m: 99 };
      default: return { ...base, observation_id: `obs-${pad(i - 1)}`, sea_level_anomaly_m: 5.55 };
    }
  }
  return base;
}
const isViolation = (i) => i % 10 === 0;
const isCritical = (i) => !isViolation(i) && i % 15 === 0 ? true : false;
const items = Array.from({ length: TOTAL }, (_, k) => { const it = item(k + 1); if (isCritical(k + 1)) it.critical = true; return it; });
const log = [];
let outageUntil = 0;
// Extra deviant behaviours that do not change the default stream (so the counts above stay valid):
//   POST /admin/inject?kind=stale|missing|null  appends one item of that kind to the END of the stream (B1 silent freeze, B3 missing/null required field); listed by /admin/expected-extra.
//   POST /admin/transport?mode=hang|429|500|truncated|garbage&ms=N  makes /v1/observations misbehave for N ms (B8); /healthz stays 200 throughout.
const extra = [];
let transport = { mode: null, until: 0 };

const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const caller = req.headers['x-aggregator-instance'] ?? null;
  if (url.pathname === '/healthz') return json(res, 200, { status: 'ok' });
  if (url.pathname === '/admin/request-log') return json(res, 200, { data: log });
  if (url.pathname === '/admin/expected') {
    const ids = items.map((_, k) => k + 1);
    return json(res, 200, {
      total: TOTAL,
      valid: ids.filter((i) => !isViolation(i)).map((i) => `obs-${pad(i)}`),
      violations: ids.filter(isViolation).map((i) => `obs-${pad(i)}`),
      critical: ids.filter(isCritical).map((i) => `obs-${pad(i)}`),
    });
  }
  if (url.pathname === '/admin/expected-extra') return json(res, 200, { items: extra });
  if (url.pathname === '/admin/inject' && req.method === 'POST') {
    const kind = url.searchParams.get('kind');
    const n = items.length + 1;
    const it = { ...item(1), observation_id: `obs-${pad(n)}` };
    it.station_id = STATIONS[n % STATIONS.length].station_id;
    if (kind === 'stale') it.observed_at = new Date(startedAt - 6 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    else if (kind === 'missing') delete it.wave_height_m;
    else if (kind === 'null') it.sea_level_anomaly_m = null;
    else return json(res, 400, { error: { code: 'bad_request', message: 'kind harus stale|missing|null' } });
    items.push(it); extra.push({ kind, observation_id: it.observation_id });
    return json(res, 200, { observation_id: it.observation_id });
  }
  if (url.pathname === '/admin/transport' && req.method === 'POST') { transport = { mode: url.searchParams.get('mode'), until: Date.now() + Number(url.searchParams.get('ms') ?? 5000) }; return json(res, 200, transport); }
  if (url.pathname === '/admin/outage' && req.method === 'POST') { outageUntil = Date.now() + Number(url.searchParams.get('ms') ?? 5000); return json(res, 200, { until: outageUntil }); }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, { error: { code: 'unauthorized', message: 'token tidak valid' } });
  log.push({ ts: new Date().toISOString(), path: url.pathname, caller, status: Date.now() < outageUntil ? 503 : 200 });
  if (Date.now() < outageUntil) return json(res, 503, { error: { code: 'unavailable', message: 'sedang gangguan' } });
  if (url.pathname === '/v1/stations') return json(res, 200, { items: STATIONS });
  if (url.pathname === '/v1/observations' && transport.mode && Date.now() < transport.until) {
    if (transport.mode === 'hang') return; // never answers; the caller's timeout must fire
    if (transport.mode === '429') { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' }); return res.end(JSON.stringify({ error: { code: 'rate_limited', message: 'terlalu banyak permintaan' } })); }
    if (transport.mode === '500') return json(res, 500, { error: { code: 'internal', message: 'galat internal' } });
    if (transport.mode === 'truncated') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"generated_at":"2026-11-12T02:43:05Z","items":[{"observation_id":"obs-0000'); }
    if (transport.mode === 'garbage') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(Buffer.from([0xff, 0xfe, 0x00, 0x7b, 0xc3, 0x28])); }
  }
  if (url.pathname === '/v1/observations') {
    let offset = 0;
    const cursor = url.searchParams.get('cursor');
    if (cursor) { try { offset = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')).o; } catch { return json(res, 400, { error: { code: 'bad_request', message: 'cursor tidak valid' } }); } }
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), PAGE);
    const page = items.slice(offset, offset + limit);
    const next = Buffer.from(JSON.stringify({ o: offset + page.length })).toString('base64');
    return json(res, 200, { generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), items: page, next_cursor: next });
  }
  return json(res, 404, { error: { code: 'not_found', message: 'route tidak ditemukan' } });
}).listen(PORT, '127.0.0.1');
