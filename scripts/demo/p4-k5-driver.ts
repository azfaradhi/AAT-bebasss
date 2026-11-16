import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Coordinator, CursorState, FenceToken, StorageClient } from '../../shared-types/src/m2/types';
import { createIngestContext } from '../../services/aggregator/src/ingest/context';
import { FireSink } from '../../services/satellite-processor/src/fire/fire-sink';
import { FeedClient } from '../../services/satellite-processor/src/feed-client';
import { SatelliteMetrics } from '../../services/satellite-processor/src/metrics';
import { runSatellite } from '../../services/satellite-processor/src/processor';
import { InMemoryStorage } from '../../services/satellite-processor/test-support/contract-fakes/fakes/in-memory-storage';

const FEED = process.env.FEED_URL ?? 'http://127.0.0.1:18097';
const OUT = process.env.OUT_DIR ?? '/tmp/p4-k5';
const KILLS = Number(process.env.KILLS ?? 40);
const WRITE_RANGE: [number, number] = [Number(process.env.KILL_MIN_WRITES ?? 5), Number(process.env.KILL_MAX_WRITES ?? 150)];

let seed = Number(process.env.SEED ?? 20261117);
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

// What survives a process death: the cursor and the fence counter (the real Coordinator keeps them in the ring).
class Shared { state: CursorState<unknown> | null = null; version = 0; fence = 0; }

class Generation implements Coordinator {
  readonly abort = new AbortController();
  dead = false;
  writes = 0;
  fence: FenceToken = 0;
  constructor(private readonly shared: Shared, private readonly ring: StorageClient, private readonly dieAfter: number | null) {}

  die(): void { this.dead = true; this.abort.abort(); }
  tick(): void { if (this.dead) throw new Error('process is dead'); if (this.dieAfter !== null && ++this.writes >= this.dieAfter) { this.die(); throw new Error('killed'); } }

  async runAsLeader(name: string, fn: (ctx: { fence: FenceToken; signal: AbortSignal }) => Promise<void>): Promise<void> {
    this.fence = ++this.shared.fence;
    await this.ring.fenceBarrier(name, this.fence);
    await fn({ fence: this.fence, signal: this.abort.signal }).catch(() => undefined);
  }
  isLeader(): boolean { return !this.dead; }
  currentFence(): FenceToken | null { return this.fence; }
  async readCursor<T>(): Promise<{ state: CursorState<T> | null; version: string }> {
    if (this.dead) throw new Error('process is dead');
    return { state: this.shared.state ? (structuredClone(this.shared.state) as CursorState<T>) : null, version: String(this.shared.version) };
  }
  async commitCursor<T>(_n: string, expectedVersion: string, next: CursorState<T>, fence: FenceToken): Promise<boolean> {
    this.tick();
    if (fence !== this.shared.fence || String(this.shared.version) !== expectedVersion) return false;
    this.shared.state = structuredClone(next) as CursorState<unknown>;
    this.shared.version++;
    return true;
  }
  async stop(): Promise<void> { this.abort.abort(); }

  // The ring as seen by this process: every write can be the one it dies on, and a dead process writes nothing more.
  storage(): StorageClient {
    return new Proxy(this.ring, {
      get: (target, prop, receiver) => {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof value !== 'function') return value;
        const isWrite = ['putDoc', 'deleteDoc', 'upsertEvent', 'tombstoneEvent'].includes(String(prop));
        return (...args: unknown[]) => {
          if (this.dead) return Promise.reject(new Error('process is dead'));
          if (isWrite) { try { this.tick(); } catch (e) { return Promise.reject(e); } }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as StorageClient;
  }
}

interface Totals { kills: number; generations: number; framesDelivered: number }

async function run(label: string, kills: number): Promise<{ ring: InMemoryStorage; totals: Totals; lastOffset: number }> {
  const ring = new InMemoryStorage();
  const shared = new Shared();
  const totals: Totals = { kills: 0, generations: 0, framesDelivered: 0 };
  const session = (await (await fetch(`${FEED}/v1/session`)).json()) as { latest_offset: number };
  const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

  while ((shared.state?.position as { offset?: number } | undefined)?.offset !== session.latest_offset) {
    if (totals.generations > 3000) throw new Error(`${label}: no progress after ${totals.generations} generations`);
    const killThis = totals.kills < kills;
    const gen = new Generation(shared, ring, killThis ? WRITE_RANGE[0] + Math.floor(rnd() * (WRITE_RANGE[1] - WRITE_RANGE[0])) : null);
    totals.generations++;
    const storage = gen.storage();
    const sink = new FireSink(storage);
    const counted = { apply: async (batch: Parameters<FireSink['apply']>[0], ctx: Parameters<FireSink['apply']>[1]) => { totals.framesDelivered += batch.length; await sink.apply(batch, ctx); } };
    const done = runSatellite({
      coordinator: gen, ingest: createIngestContext({ storage, env: {} }), sink: counted, metrics: new SatelliteMetrics(), logger: quiet,
      client: new FeedClient({ baseUrl: FEED, token: 'x', idleTimeoutMs: 10_000 }),
      config: { SAT_CHECKPOINT_EVERY_N: 20, SAT_BATCH_SIZE: 20, SAT_FLUSH_INTERVAL_MS: 20, SAT_RECONNECT_MIN_MS: 1, SAT_RECONNECT_MAX_MS: 20, POD_NAME: `${label}-${totals.generations}` },
    });
    const deadline = Date.now() + 60_000;
    while (!gen.dead && (shared.state?.position as { offset?: number } | undefined)?.offset !== session.latest_offset && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2));
    if (gen.dead) totals.kills++;
    else gen.die(); // finished: stop the healthy process
    await Promise.race([done, new Promise((r) => setTimeout(r, 2000))]);
  }
  return { ring, totals, lastOffset: session.latest_offset };
}

async function exportEvents(ring: InMemoryStorage): Promise<string> {
  const events = (await ring.listEvents({ source: 'SATELIT', limit: 10_000 })).items
    .map(({ ingested_at: _ignored, ...rest }) => rest)
    .sort((a, b) => (a.hazard_id < b.hazard_id ? -1 : 1));
  return JSON.stringify(events, null, 1) + '\n';
}

(async () => {
  mkdirSync(OUT, { recursive: true });
  const clean = await run('clean', 0);
  const faulty = await run('faulty', KILLS);
  const a = await exportEvents(clean.ring);
  const b = await exportEvents(faulty.ring);
  writeFileSync(`${OUT}/fault-free.json`, a);
  writeFileSync(`${OUT}/with-kills.json`, b);
  const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
  const count = (s: string) => (JSON.parse(s) as unknown[]).length;
  const dupIds = (s: string) => { const ids = (JSON.parse(s) as Array<{ hazard_id: string }>).map((e) => e.hazard_id); return ids.length - new Set(ids).size; };
  const rows: Array<[string, string, boolean]> = [
    ['processor killed at random write points', `${faulty.totals.kills} kills over ${faulty.totals.generations} process lifetimes`, faulty.totals.kills >= KILLS],
    ['fault-free events / with-kills events', `${count(a)} / ${count(b)}`, count(a) === count(b) && count(a) > 0],
    ['duplicate hazard ids with kills', String(dupIds(b)), dupIds(b) === 0],
    ['byte-identical export (ingested_at ignored)', `sha ${sha(a)} vs ${sha(b)}`, a === b],
    ['frames delivered to the sink: fault-free / with-kills', `${clean.totals.framesDelivered} / ${faulty.totals.framesDelivered}`, true],
  ];
  for (const [name, value, ok] of rows) console.log(`${name.padEnd(58)} | ${value.padEnd(52)} | ${ok ? 'PASS' : 'FAIL'}`);
  const failed = rows.filter((r) => !r[2]).length;
  console.log(`exports: ${OUT}/fault-free.json, ${OUT}/with-kills.json`);
  console.log(failed === 0 ? '\nPASS: result after repeated kills equals the fault-free run' : `\nFAIL: ${failed} check(s)`);
  process.exit(failed === 0 ? 0 : 1);
})();
