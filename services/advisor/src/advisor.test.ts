import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain JS fake LLM
import { startFakeLlm } from '../../../tools/fake-llm/server.mjs';
import { hazardId } from '../../../shared-types/src/m2/ids';
import type { StoredHazardEvent } from '../../../shared-types/src/m2/types';
import { InMemoryStorage } from '../test-support/contract-fakes/fakes/in-memory-storage';
import { Advisor } from './advisor';
import { AnomalyDetector } from './detector';
import { LABEL, templateSummary, validateSummary, type FireFacts, type Flag } from './facts';
import { LlmClient } from './llm';
import { BoundedQueue, CircuitBreaker, TokenBucket } from './resilience';
import { StorageAdvisoryStore, StorageEventSource } from './store';

const opts = { windowMs: 300_000, zThreshold: 3.5, minGrowth: 3, minFires: 5, frpFactor: 1.5, frpMinDelta: 20 };
const facts = (over: Partial<FireFacts> = {}): FireFacts => ({ id: 'hz-1', province: 'Riau', count: 14, satellites: ['N', 'N20'], frp: 61.5, severity: 'SIAGA', earliest: '2026-11-16T05:30:00.000Z', ...over });
const flag = (over: Partial<Flag> = {}): Flag => ({ id: 'hz-1', score: 5, reasons: ['pertumbuhan 9 titik panas dalam jendela waktu, jauh di atas kebakaran lain'], growth: 9, ...over });

describe('anomaly detector', () => {
  const fleet = (counts: number[], frp = 10): FireFacts[] => counts.map((c, i) => facts({ id: `f${i}`, count: c, frp }));

  it('flags a fire whose growth is an outlier among the others, and nothing when growth is ordinary', () => {
    const d = new AnomalyDetector(opts);
    d.observe(0, fleet([4, 4, 5, 4, 6, 5, 4, 5]));
    const flags = d.observe(60_000, fleet([4, 5, 5, 4, 7, 5, 4, 15]));
    expect(flags.map((f) => f.id)).toEqual(['f7']);
    expect(flags[0].growth).toBe(10);
    expect(new AnomalyDetector(opts).observe(0, fleet([4, 4, 5, 4, 6, 5, 4, 5]))).toEqual([]);
  });

  it('needs a population and a minimum absolute growth', () => {
    const d = new AnomalyDetector(opts);
    d.observe(0, fleet([4, 4, 5]));
    expect(d.observe(60_000, fleet([4, 4, 12]))).toEqual([]); // 3 fires < minFires
    const e = new AnomalyDetector(opts);
    e.observe(0, fleet([4, 4, 5, 4, 6]));
    expect(e.observe(60_000, fleet([4, 4, 5, 4, 7]))).toEqual([]); // growth 1 < minGrowth
  });

  it('flags a severity step up and a total FRP jump', () => {
    const d = new AnomalyDetector(opts);
    d.observe(0, [facts({ id: 'a', severity: 'WASPADA', frp: 10, count: 4 })]);
    const flags = d.observe(60_000, [facts({ id: 'a', severity: 'SIAGA', frp: 45, count: 4 })]);
    expect(flags[0].reasons.join(' ')).toMatch(/tingkat naik ke SIAGA/);
    expect(flags[0].reasons.join(' ')).toMatch(/total FRP naik/);
  });
});

describe('summary validation', () => {
  it('accepts a faithful sentence and rejects anything outside the facts we sent', () => {
    const f = facts();
    const g = flag();
    expect(validateSummary(templateSummary(f, g), f, g).ok).toBe(true);
    expect(validateSummary('Terdapat 14 titik panas di Riau dengan total FRP 61,5 MW dari dua satelit.', f, g).ok).toBe(true);
    for (const bad of [
      'Kebakaran di Riau menewaskan 250 orang dan membakar 1200 hektar.', 'Kebakaran besar terjadi di Jambi dengan 14 titik panas.',
      '**Riau** 14 titik panas, lihat https://contoh.example', 'pendek', 'Riau\nbaris kedua dengan 14 titik panas yang cukup panjang', 'Riau ' + 'x'.repeat(300),
    ]) expect(validateSummary(bad, f, g).ok, bad).toBe(false);
    expect(validateSummary(null, f, g).ok).toBe(false);
    expect(validateSummary('Di Riau terdeteksi 14 titik panas sejak 2026-11-16 pukul 05:30 dengan total FRP 61,5 MW.', f, g).ok).toBe(true);
    expect(validateSummary('Di Riau terdeteksi 14 titik panas sejak 2026-11-16T05:30:00.000Z dengan total FRP 61,5 MW.', f, g).ok).toBe(true); // raw ISO timestamp // date and time of the facts are allowed
  });
});

describe('resilience primitives', () => {
  it('opens after the threshold, probes once after the cooldown, closes on success', () => {
    let now = 0;
    const b = new CircuitBreaker(3, 1000, () => now);
    [1, 2, 3].forEach(() => b.failure());
    expect(b.state()).toBe('open');
    expect(b.allow()).toBe(false);
    now = 1000;
    expect(b.state()).toBe('half_open');
    expect([b.allow(), b.allow()]).toEqual([true, false]); // one probe at a time
    b.success();
    expect(b.state()).toBe('closed');
  });

  it('rate limits with a refilling bucket and drops the oldest job when the queue is full', async () => {
    let now = 0;
    const bucket = new TokenBucket(2, () => now);
    expect([bucket.take(), bucket.take(), bucket.take()]).toEqual([true, true, false]);
    now = 30_000;
    expect(bucket.take()).toBe(true);

    const seen: number[] = [];
    const dropped: number[] = [];
    const q = new BoundedQueue<number>(2, async (n) => { await new Promise((r) => setTimeout(r, 20)); seen.push(n); }, (n) => dropped.push(n));
    [1, 2, 3, 4, 5].forEach((n) => q.push(n));
    await q.idle();
    expect(dropped.length).toBeGreaterThan(0);
    expect(seen.length + dropped.length).toBe(5);
  });
});

describe('advisor beside the alert path', () => {
  let llmServer: Awaited<ReturnType<typeof startFakeLlm>> | null = null;
  afterEach(async () => { await llmServer?.close(); llmServer = null; });

  async function setup(mode: string, over: { timeoutMs?: number; breakerFailures?: number; withLlm?: boolean; rate?: number } = {}) {
    llmServer = await startFakeLlm({ mode });
    const storage = new InMemoryStorage();
    let now = 1_000_000;
    const clock = () => now;
    const llm = over.withLlm === false ? null : new LlmClient({ baseUrl: llmServer.url, model: 'test-model', apiKey: 'test-key', timeoutMs: over.timeoutMs ?? 300 });
    const advisor = new Advisor({
      source: new StorageEventSource(storage), store: new StorageAdvisoryStore(storage), detector: new AnomalyDetector(opts), llm, model: llm ? 'test-model' : null,
      breaker: new CircuitBreaker(over.breakerFailures ?? 3, 60_000, clock), bucket: new TokenBucket(over.rate ?? 600, clock), queueMax: 50, clock,
    });
    const put = async (id: string, count: number, frp = 20) => {
      const e = { hazard_id: hazardId('SATELIT', id), source: 'SATELIT', source_ref_id: id, hazard_type: 'WILDFIRE', severity: 'WASPADA', area_name: 'Riau', latitude: 0, longitude: 100,
        occurred_at: '2026-11-16T05:30:00.000Z', ingested_at: '2026-11-16T05:31:00.000Z', attributes: { detection_count: count, satellites: ['N'], total_frp_mw: frp }, version: count } as StoredHazardEvent;
      await storage.upsertEvent(e, { fence: 1, idempotencyKey: `${id}-${count}`, correlationId: 'seed', fenceName: 'satellite' });
      return e.hazard_id;
    };
    // eight quiet fires, then one that jumps
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push(await put(`q${i}`, 4 + (i % 2)));
    await advisor.tick();
    now += 60_000;
    const hot = await put('hot', 4);
    await advisor.tick();
    now += 60_000;
    await put('hot', 16);
    return { advisor, storage, store: new StorageAdvisoryStore(storage), tick: () => advisor.tick(), hot, advance: (ms: number) => { now += ms; }, ids };
  }

  it('normal: flags the fire, stores a template at once and upgrades it with a validated LLM sentence', async () => {
    const { advisor, store, hot, tick } = await setup('normal');
    const flags = await tick();
    expect(flags.map((f) => f.id)).toEqual([hot]);
    await advisor.idle();
    const rec = await store.get(hot);
    expect(rec).toMatchObject({ flagged: true, summary_source: 'llm', model: 'test-model', label: LABEL });
    expect(rec!.summary).toContain('Riau');
  });

  it.each(['slow', 'dead', 'error', 'garbage', 'hallucinate', 'markup'])('%s: the template record stands and nothing throws', async (mode) => {
    const { advisor, store, hot, tick } = await setup(mode, { timeoutMs: 150 });
    await expect(tick()).resolves.toHaveLength(1);
    await advisor.idle();
    const rec = await store.get(hot);
    expect(rec).toMatchObject({ flagged: true, summary_source: 'template', model: null, label: LABEL });
    const m = advisor.metrics;
    expect(mode === 'slow' ? m.get('timeout') : mode === 'hallucinate' || mode === 'markup' ? m.get('rejected') : m.get('llm_error')).toBe(1);
  });

  it('dead then back: the breaker opens, skips calls while open, and closes after a successful probe', async () => {
    const { advisor, tick, advance, storage, hot } = await setup('dead', { breakerFailures: 2 });
    // two more fires so the same fire keeps being re-summarized as it grows
    await tick(); await advisor.idle();
    let count = 16;
    for (let i = 0; i < 4; i++) {
      count += 8;
      await storage.upsertEvent({ hazard_id: hot, source: 'SATELIT', source_ref_id: 'hot', hazard_type: 'WILDFIRE', severity: 'WASPADA', area_name: 'Riau', latitude: 0, longitude: 100, occurred_at: '2026-11-16T05:30:00.000Z', ingested_at: '2026-11-16T05:31:00.000Z', attributes: { detection_count: count, satellites: ['N'], total_frp_mw: 20 }, version: count } as StoredHazardEvent, { fence: 1, idempotencyKey: `h${count}`, correlationId: 's', fenceName: 'satellite' });
      advance(10_000); // shorter than the breaker cooldown
      await tick(); await advisor.idle();
    }
    expect(advisor.metrics.breaker).toBe('open');
    expect(advisor.metrics.get('breaker_open')).toBeGreaterThanOrEqual(1);
    llmServer!.setMode('normal');
    advance(61_000);
    count += 8;
    await storage.upsertEvent({ hazard_id: hot, source: 'SATELIT', source_ref_id: 'hot', hazard_type: 'WILDFIRE', severity: 'WASPADA', area_name: 'Riau', latitude: 0, longitude: 100, occurred_at: '2026-11-16T05:30:00.000Z', ingested_at: '2026-11-16T05:31:00.000Z', attributes: { detection_count: count, satellites: ['N'], total_frp_mw: 20 }, version: count } as StoredHazardEvent, { fence: 1, idempotencyKey: `h${count}`, correlationId: 's', fenceName: 'satellite' });
    await tick(); await advisor.idle();
    expect(advisor.metrics.breaker).toBe('closed');
    expect(advisor.metrics.get('llm')).toBe(1);
  });

  it('no key (no LLM): template-only mode still flags and stores', async () => {
    const { advisor, store, hot, tick } = await setup('normal', { withLlm: false });
    await tick(); await advisor.idle();
    expect((await store.get(hot))?.summary_source).toBe('template');
    expect(llmServer!.stats.requests).toBe(0);
  });

  it('rate limit: no LLM call beyond the bucket, template stands', async () => {
    const { advisor, store, hot, tick } = await setup('normal', { rate: 1 });
    const start = llmServer!.stats.requests;
    await tick(); await advisor.idle();
    expect(llmServer!.stats.requests - start).toBeLessThanOrEqual(1);
    expect(await store.get(hot)).not.toBeNull();
  });

  it('is isolated: advisory records never change or appear among the events', async () => {
    const { advisor, storage, tick } = await setup('normal');
    const before = JSON.stringify((await storage.listEvents({ source: 'SATELIT', limit: 100 })).items);
    await tick(); await advisor.idle();
    expect(JSON.stringify((await storage.listEvents({ source: 'SATELIT', limit: 100 })).items)).toBe(before);
    expect((await storage.listDocs('fire_state', { prefix: 'advisory:', limit: 10 })).items.length).toBeGreaterThan(0);
  });

  it('an unreadable event source is absorbed (counted), the tick returns nothing', async () => {
    const { advisor, storage } = await setup('normal');
    for (const u of storage.units()) storage.setUnitState(u, 'DOWN');
    const failing = new Advisor({ source: { fires: async () => { throw new Error('ring down'); } }, store: new StorageAdvisoryStore(storage), detector: new AnomalyDetector(opts), llm: null, model: null, breaker: new CircuitBreaker(3, 1000), bucket: new TokenBucket(10), queueMax: 5 });
    await expect(failing.tick()).resolves.toEqual([]);
    expect(failing.metrics.get('source_error')).toBe(1);
  });
});
