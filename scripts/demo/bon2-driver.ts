import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Advisor } from '../../services/advisor/src/advisor';
import { AnomalyDetector } from '../../services/advisor/src/detector';
import { LlmClient } from '../../services/advisor/src/llm';
import { CircuitBreaker, TokenBucket } from '../../services/advisor/src/resilience';
import { StorageAdvisoryStore, StorageEventSource } from '../../services/advisor/src/store';
import { FireSink } from '../../services/satellite-processor/src/fire/fire-sink';
import type { SatFrame } from '../../services/satellite-processor/src/sink';
import { InMemoryStorage } from '../../services/satellite-processor/test-support/contract-fakes/fakes/in-memory-storage';

const FEED = process.env.FEED_URL ?? 'http://127.0.0.1:18104';
const LLM = process.env.FAKE_LLM_URL ?? 'http://127.0.0.1:18105';
const OUT = process.env.OUT_DIR ?? '/tmp/bon2';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const setMode = (mode: string) => fetch(`${LLM}/admin/mode`, { method: 'POST', body: JSON.stringify({ mode }) });

interface Frame { id: number; event: string; data: Record<string, unknown> }
const ctx = { fence: 1, signal: new AbortController().signal };

async function exportEvents(ring: InMemoryStorage): Promise<string> {
  const events = (await ring.listEvents({ source: 'SATELIT', limit: 100_000 })).items.map(({ ingested_at: _i, ...e }) => e).sort((a, b) => (a.hazard_id < b.hazard_id ? -1 : 1));
  return JSON.stringify(events);
}

// The alert path: apply the frames in batches (this is what produces the events). `withAdvisor` runs the advisor beside it.
async function run(frames: SatFrame[], withAdvisor: boolean, modeAt: (batch: number, of: number) => string) {
  const ring = new InMemoryStorage();
  const sink = new FireSink(ring);
  let advisor: Advisor | null = null;
  let stop = false;
  let ticker: Promise<void> = Promise.resolve();
  const modesSeen: string[] = [];
  const breakerStates = new Set<string>();
  if (withAdvisor) {
    advisor = new Advisor({
      source: new StorageEventSource(ring), store: new StorageAdvisoryStore(ring),
      detector: new AnomalyDetector({ windowMs: 1500, zThreshold: 3.5, minGrowth: 2, minFires: 5, frpFactor: 1.5, frpMinDelta: 20 }),
      llm: new LlmClient({ baseUrl: LLM, model: 'fake-model', apiKey: 'demo', timeoutMs: 300 }), model: 'fake-model',
      breaker: new CircuitBreaker(4, 600), bucket: new TokenBucket(600), queueMax: 50,
    });
    ticker = (async () => { while (!stop) { await advisor!.tick(); breakerStates.add(advisor!.metrics.breaker); await sleep(120); } })();
  }
  const batches = Math.ceil(frames.length / 100);
  const apply: number[] = [];
  for (let i = 0; i < batches; i++) {
    const mode = modeAt(i, batches);
    if (withAdvisor && modesSeen[modesSeen.length - 1] !== mode) { modesSeen.push(mode); await setMode(mode); }
    const t = performance.now();
    await sink.apply(frames.slice(i * 100, i * 100 + 100), ctx);
    apply.push(performance.now() - t);
    await sleep(25); // paced so the advisor's ticks interleave with the alert path
  }
  await setMode('normal');
  if (advisor) { await sleep(400); stop = true; await ticker; await advisor.tick(); await advisor.idle(); }
  apply.sort((a, b) => a - b);
  return { ring, advisor, apply, p95: apply[Math.floor(apply.length * 0.95)], mean: apply.reduce((a, b) => a + b, 0) / apply.length, modesSeen, breakerStates };
}

(async () => {
  mkdirSync(OUT, { recursive: true });
  const raw = (await (await fetch(`${FEED}/admin/frames`)).json()) as Frame[];
  const frames: SatFrame[] = raw.filter((f) => f.event !== 'heartbeat').map((f) => ({ offset: f.id, kind: f.event as SatFrame['kind'], data: f.data }));
  // normal -> slow -> normal -> dead -> normal -> hallucinating -> normal across the run (a healthy phase in between lets the breaker close)
  const schedule = ['normal', 'slow', 'normal', 'dead', 'normal', 'hallucinate', 'normal'];
  const modeAt = (i: number, n: number) => schedule[Math.min(schedule.length - 1, Math.floor((i / n) * schedule.length))];

  const without = await run(frames, false, modeAt);
  const withAdv = await run(frames, true, modeAt);
  const a = await exportEvents(without.ring);
  const b = await exportEvents(withAdv.ring);
  const m = withAdv.advisor!.metrics;
  const advisories = (await withAdv.ring.listDocs<{ summary_source: string; summary: string; label: string }>('fire_state', { prefix: 'advisory:', limit: 10_000 })).items.map((i) => i.doc);
  const bySource = advisories.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.summary_source]: (acc[r.summary_source] ?? 0) + 1 }), {});
  const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
  const sample = advisories.find((r) => r.summary_source === 'llm') ?? advisories[0];

  const summary = {
    events: { without_advisor: JSON.parse(a).length, with_advisor: JSON.parse(b).length, identical: a === b, sha: sha(a) },
    alert_path_batch_apply_ms: { without: { mean: +without.mean.toFixed(2), p95: +without.p95.toFixed(2) }, with_advisor: { mean: +withAdv.mean.toFixed(2), p95: +withAdv.p95.toFixed(2) } },
    llm_modes_exercised: withAdv.modesSeen, breaker_states_seen: [...withAdv.breakerStates],
    advisor_outcomes: Object.fromEntries((['flagged', 'llm', 'template', 'timeout', 'llm_error', 'rejected', 'breaker_open', 'rate_limited', 'dropped', 'source_error', 'store_error'] as const).map((o) => [o, m.get(o)])),
    advisory_records: { total: advisories.length, by_source: bySource, every_record_labelled: advisories.every((r) => r.label.startsWith('ADVISORY')) },
    example: sample ? { source: sample.summary_source, summary: sample.summary } : null,
  };
  writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));

  const ratioOk = withAdv.p95 <= without.p95 * 1.5 + 25;
  const rows: Array<[string, string, boolean]> = [
    ['alert-path events identical with and without the advisor', `${summary.events.with_advisor} events, sha ${summary.events.sha}`, summary.events.identical && summary.events.with_advisor > 0],
    ['alert-path batch p95 not degraded (<= 1.5x + 25 ms)', `${summary.alert_path_batch_apply_ms.without.p95} ms vs ${summary.alert_path_batch_apply_ms.with_advisor.p95} ms`, ratioOk],
    ['advisor flagged unusual fires', `${m.get('flagged')} flags, ${advisories.length} records`, m.get('flagged') > 0 && advisories.length > 0],
    ['every record carries the advisory label', String(summary.advisory_records.every_record_labelled), summary.advisory_records.every_record_labelled],
    ['slow LLM timed out, dead LLM failed, wrong LLM rejected', `timeout ${m.get('timeout')}, error ${m.get('llm_error')}, rejected ${m.get('rejected')}`, m.get('timeout') > 0 && m.get('llm_error') > 0 && m.get('rejected') > 0],
    ['breaker opened and calls were skipped', `states ${[...withAdv.breakerStates].join(',')}, skipped ${m.get('breaker_open')}`, withAdv.breakerStates.has('open') && m.get('breaker_open') > 0],
    ['a validated LLM summary was stored when the LLM was healthy', `llm ${bySource.llm ?? 0}, template ${bySource.template ?? 0}`, (bySource.llm ?? 0) > 0],
    ['advisory records are not events', 'checked via listEvents export', !a.includes('advisory') && !b.includes('advisory')],
  ];
  for (const [name, value, ok] of rows) console.log(`${name.padEnd(62)} | ${value.padEnd(44)} | ${ok ? 'PASS' : 'FAIL'}`);
  const failed = rows.filter((r) => !r[2]).length;
  console.log(failed === 0 ? '\nPASS: the advisor adds advisory records and changes nothing on the alert path' : `\nFAIL: ${failed} check(s)`);
  process.exit(failed === 0 ? 0 : 1);
})();
