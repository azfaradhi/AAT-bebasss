// P5-K5 on the cluster: when load exceeds capacity, Field-Team (lapangan) requests are still served while Media requests are rejected in a controlled way (429 + Retry-After).
//   usage: node scripts/cluster/drills/p5-priority-shed.mjs      env: MEDIA_CONC=150 FIELD_CONC=10 DURATION_S=40
import { Evidence, clientToken, expose, p95, timed } from './lib.mjs';

const MEDIA = Number(process.env.MEDIA_CONC ?? 150), FIELD = Number(process.env.FIELD_CONC ?? 10), DURATION = Number(process.env.DURATION_S ?? 40);
const ev = new Evidence('P5/K5', 'cluster-p5-priority-shed', `P5-K5: ${MEDIA} concurrent media clients vs ${FIELD} lapangan clients for ${DURATION} s`);
const client = expose('client-api', 8080), auth = expose('auth-service', 8091);
const tok = { media: await clientToken(auth, 'media'), lapangan: await clientToken(auth, 'lapangan') };
const stat = { media: { ok: 0, shed: 0, retryAfter: 0, other: [], ms: [] }, lapangan: { ok: 0, shed: 0, retryAfter: 0, other: [], ms: [] } };
let stop = false;
const worker = async (role) => { while (!stop) { const r = await timed(`${client}/api/v1/hazards?limit=50`, { headers: { authorization: `Bearer ${tok[role]}` } }, 10000); const s = stat[role]; s.ms.push(r.ms); if (r.status === 200) s.ok++; else if (r.status === 429) { s.shed++; } else s.other.push(r.status); } };
const pool = [...Array(MEDIA).fill('media'), ...Array(FIELD).fill('lapangan')].map(worker);
await new Promise((r) => setTimeout(r, DURATION * 1000)); stop = true; await Promise.all(pool);
for (const r of ['media', 'lapangan']) { const s = stat[r]; ev.log(`${r}: 200=${s.ok} 429=${s.shed} other=${[...new Set(s.other)].join(',') || 'none'} p95=${p95(s.ms).toFixed(0)} ms`); }
const f = stat.lapangan, m = stat.media;
ev.check('lapangan requests are served (>= 95 % answered 200)', f.ok / Math.max(1, f.ok + f.shed + f.other.length) >= 0.95);
ev.check('media requests are rejected in a controlled way (some 429, no 5xx)', m.shed > 0 && m.other.filter((c) => c >= 500 || c === 0).length === 0);
ev.check('overload did not take lapangan down (p95 < 5000 ms)', p95(f.ms) < 5000);
ev.done();
