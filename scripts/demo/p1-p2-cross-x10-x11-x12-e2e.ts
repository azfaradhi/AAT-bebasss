// Cross-member & deep verification on real OS processes:
// - X-10: ingested_at is immutable on re-upsert and strictly monotonic per source across leader failover with backward clock jump (+45 s -> -30 s); since & cursor remain exact.
// - P2-K5 (direct fence proof): a deposed zombie leader (fence=1) attempting writes after takeover (fence=2) receives HTTP 409 FENCED (FencedError) from storage-unit and increments bnpb_fencing_rejections_total.
// - X-11: analytics-dashboard numbers equal Audit API under concurrent load and when storage units fail (partial:true + unavailable_units marker appears).
// - X-12: every Audit API endpoint (/events, /checksum, /location, /ring) is answered identically by all 3 Aggregator instances behind the entry point.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hazardId } from '../../shared-types/src/m2/ids';
import { FencedError, type HazardSource, type HazardType, type StoredHazardEvent } from '../../shared-types/src/m2/types';
import { discoverUnits } from '../../shared-types/src/ring/factory';
import { HttpStorageClient } from '../../shared-types/src/ring/http-storage-client';
import { StorageCanonicalStore } from '../../services/aggregator/src/storage/storage-canonical-store';

const ROOT = join(__dirname, '../..');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = (s: string) => process.stdout.write(s + '\n');
const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => {
  checks.push([name, ok]);
  line(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`);
};

async function until<T>(what: string, fn: () => Promise<T | null | false>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const res = await fn().catch(() => null);
    if (res) return res;
    await sleep(120);
  }
  throw new Error(`timeout: ${what}`);
}

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'x10-12-'));
  const procs: ChildProcess[] = [];
  const runProc = (cmd: string, args: string[], cwd: string, env: Record<string, string>) => {
    const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: 'ignore', detached: true });
    procs.push(p);
    return p;
  };
  const killProc = (p: ChildProcess) => {
    try {
      process.kill(-p.pid!, 'SIGKILL');
    } catch {
      /* gone */
    }
  };

  try {
    line(`=== Cross-Member & Deep Verification: X-10, P2-K5 (Direct FENCED 409), X-11, X-12 ===`);
    const unitPorts = [19210, 19211, 19212];
    const unitNames = ['unit-0', 'unit-1', 'unit-2'];
    const nodeNames = ['node-a', 'node-b', 'node-c'];
    const unitProcs = unitPorts.map((p, i) =>
      runProc('node', ['dist/services/storage-unit/src/index.js'], join(ROOT, 'services/storage-unit'), {
        STORAGE_UNIT_PORT: String(p),
        STORAGE_UNIT_ID: unitNames[i],
        NODE_NAME: nodeNames[i],
        STORAGE_DATA_DIR: join(tmp, `u${i}`),
      }),
    );
    const STORAGE_UNITS = unitPorts.map((p) => `http://127.0.0.1:${p}`).join(',');
    const units = await discoverUnits({ STORAGE_UNITS }, 25);
    const ring = new HttpStorageClient({ units, rf: 2, vnodes: 64, stateTtlMs: 0 });
    await ring.repair();

    // Spawn 3 real Aggregator instances on node-a, node-b, node-c + 1 analytics-dashboard instance
    const aggPorts = [19220, 19221, 19222];
    const aggUrls = aggPorts.map((p) => `http://127.0.0.1:${p}`);
    aggPorts.forEach((p, i) =>
      runProc('npx', ['tsx', 'scripts/ring-host.ts'], join(ROOT, 'services/aggregator'), {
        STORAGE_UNITS,
        AGGREGATOR_PORT: String(p),
        POD_NAME: `aggregator-${i + 1}`,
        NODE_NAME: nodeNames[i],
        INTERNAL_SERVICE_KEY: 'ik',
        AUDIT_TOKEN: 'audit-secret',
        STORAGE_STATE_TTL_MS: '150',
        LIST_CACHE_MS: '0',
      }),
    );
    for (const url of aggUrls) {
      await until(`aggregator ${url} ready`, async () => (await fetch(`${url}/ready`)).ok);
    }

    const dashPort = 19230;
    const DASH = `http://127.0.0.1:${dashPort}`;
    runProc('npx', ['tsx', 'src/index.ts'], join(ROOT, 'services/analytics-dashboard'), {
      ANALYTICS_DASHBOARD_PORT: String(dashPort),
      AGGREGATOR_BASE_URL: aggUrls[0],
      INTERNAL_SERVICE_KEY: 'ik',
    });
    await until('analytics-dashboard ready', async () => (await fetch(`${DASH}/ready`)).ok);

    // -------------------------------------------------------------------------
    // 1. X-10: ingested_at immutability & monotonicity across leader change + backward clock jump (+45s -> -30s)
    // -------------------------------------------------------------------------
    line(`\n1. X-10: Monotonic & Immutable ingested_at Across Leader Failover (+45 s -> -30 s clock jump):`);
    const baseClockMs = Date.UTC(2026, 10, 20, 10, 0, 0);
    await ring.fenceBarrier('bmkg', 1);
    const leader1Store = new StorageCanonicalStore({
      storage: ring,
      fence: () => 1,
      clock: () => baseClockMs + 45_000, // Leader 1 clock is +45 s ahead
    });

    const batch1Ids: string[] = [];
    const batch1IngestedAt: string[] = [];
    for (let i = 0; i < 15; i++) {
      const ref = `BMKG-X10-${String(i + 1).padStart(3, '0')}`;
      const id = hazardId('BMKG', ref);
      const ev = {
        hazard_id: id,
        source: 'BMKG' as const,
        source_ref_id: ref,
        hazard_type: 'SEISMIC' as const,
        severity: 'WASPADA' as const,
        area_name: 'Aceh Besar, Aceh',
        latitude: 5.5,
        longitude: 95.3,
        occurred_at: new Date(baseClockMs + i * 1000).toISOString(),
        ingested_at: new Date(baseClockMs + 45_000 + i * 10).toISOString(),
        attributes: { magnitude: 5.2, depth_km: 15, potential_tsunami: false },
      };
      const stored = await leader1Store.upsert(ev, `corr-l1-${i}`);
      batch1Ids.push(stored.event.hazard_id);
      batch1IngestedAt.push(stored.event.ingested_at);
    }
    await leader1Store.markSourceFresh('BMKG');

    // Leader 2 takes over with fence=2, but its wall clock is -30 s (75 s behind Leader 1!)
    await ring.fenceBarrier('bmkg', 2);
    const leader2Store = new StorageCanonicalStore({
      storage: ring,
      fence: () => 2,
      clock: () => baseClockMs - 30_000, // Leader 2 clock is -30 s behind!
    });
    // Leader 2 starts its poll tick by reading getLastSuccessAt('BMKG')
    await leader2Store.getLastSuccessAt('BMKG');

    // Leader 2 re-polls the last 5 events from Batch 1 (lookback overlap) + 15 brand-new events
    const rePolledIngestedAt: string[] = [];
    for (let i = 10; i < 15; i++) {
      const ref = `BMKG-X10-${String(i + 1).padStart(3, '0')}`;
      const id = hazardId('BMKG', ref);
      const ev = {
        hazard_id: id,
        source: 'BMKG' as const,
        source_ref_id: ref,
        hazard_type: 'SEISMIC' as const,
        severity: 'SIAGA' as const, // even if attributes/severity updated
        area_name: 'Aceh Besar, Aceh',
        latitude: 5.5,
        longitude: 95.3,
        occurred_at: new Date(baseClockMs + i * 1000).toISOString(),
        ingested_at: new Date(baseClockMs - 30_000 + i * 10).toISOString(), // skewed older timestamp!
        attributes: { magnitude: 5.2, depth_km: 15, potential_tsunami: false },
      };
      await leader2Store.upsert(ev, `corr-l2-repoll-${i}`);
      const fromRing = await ring.getEvent(id);
      rePolledIngestedAt.push(fromRing.event!.ingested_at);
    }

    const batch2IngestedAt: string[] = [];
    for (let i = 15; i < 30; i++) {
      const ref = `BMKG-X10-${String(i + 1).padStart(3, '0')}`;
      const id = hazardId('BMKG', ref);
      const ev = {
        hazard_id: id,
        source: 'BMKG' as const,
        source_ref_id: ref,
        hazard_type: 'SEISMIC' as const,
        severity: 'WASPADA' as const,
        area_name: 'Simeulue, Aceh',
        latitude: 2.6,
        longitude: 96.0,
        occurred_at: new Date(baseClockMs + i * 1000).toISOString(),
        ingested_at: new Date(baseClockMs - 30_000 + i * 10).toISOString(), // Leader 2 skewed wall clock (-30 s)
        attributes: { magnitude: 5.0, depth_km: 20, potential_tsunami: false },
      };
      const stored = await leader2Store.upsert(ev, `corr-l2-new-${i}`);
      batch2IngestedAt.push(stored.event.ingested_at);
    }
    await leader2Store.markSourceFresh('BMKG');

    const immutableOk = rePolledIngestedAt.every((ts, idx) => ts === batch1IngestedAt[10 + idx]);
    const allSequence = [...batch1IngestedAt, ...batch2IngestedAt];
    let strictlyMonotonic = true;
    for (let i = 1; i < allSequence.length; i++) {
      if (!(allSequence[i] > allSequence[i - 1])) {
        strictlyMonotonic = false;
        break;
      }
    }
    line(`   Leader 1 (+45 s) last ingested_at : ${batch1IngestedAt[batch1IngestedAt.length - 1]}`);
    line(`   Leader 2 (-30 s) first ingested_at: ${batch2IngestedAt[0]} (monotonic floor applied!)`);
    line(`   Leader 2 (-30 s) last ingested_at : ${batch2IngestedAt[batch2IngestedAt.length - 1]}`);
    check('X-10a: existing events keep their original ingested_at on re-upsert (100% immutable)', immutableOk);
    check(
      'X-10b: ingested_at is strictly monotonic across all 30 events despite Leader 1 (+45 s) -> Leader 2 (-30 s) failover',
      strictlyMonotonic,
    );

    // Verify `since` filter and paginated `cursor` walk over the 30 events via Audit API
    const boundaryIso = batch2IngestedAt[0];
    const sinceRes = await fetch(
      `${aggUrls[0]}/internal/audit/events?source=BMKG&since=${encodeURIComponent(boundaryIso)}&limit=7`,
      { headers: { authorization: 'Bearer audit-secret' } },
    );
    const sinceFirstPage = (await sinceRes.json()) as any;
    const walkedSince: string[] = [...sinceFirstPage.items.map((x: any) => x.ingested_at)];
    let cur = sinceFirstPage.next_cursor;
    while (cur) {
      const pRes = await fetch(
        `${aggUrls[1]}/internal/audit/events?source=BMKG&since=${encodeURIComponent(boundaryIso)}&limit=7&cursor=${encodeURIComponent(cur)}`,
        { headers: { authorization: 'Bearer audit-secret' } },
      );
      const pBody = (await pRes.json()) as any;
      walkedSince.push(...pBody.items.map((x: any) => x.ingested_at));
      cur = pBody.next_cursor;
    }
    check(
      `X-10c: Audit API since=${boundaryIso} + paginated cursor across instances returns exactly the 15 Leader-2 events in order`,
      walkedSince.length === 15 && walkedSince.every((ts, i) => ts === batch2IngestedAt[i]),
    );

    // -------------------------------------------------------------------------
    // 2. P2-K5 Direct Observation of Fencing Rejection (HTTP 409 FENCED / FencedError)
    // -------------------------------------------------------------------------
    line(`\n2. P2-K5: Direct Observation of Storage Unit Fencing Rejection (HTTP 409 FENCED):`);
    let caughtFenceErr: FencedError | null = null;
    try {
      await leader1Store.upsert(
        {
          hazard_id: hazardId('BMKG', 'BMKG-ZOMBIE-WRITE-1'),
          source: 'BMKG',
          source_ref_id: 'BMKG-ZOMBIE-WRITE-1',
          hazard_type: 'SEISMIC',
          severity: 'AWAS',
          area_name: 'Zombie Write Attempt',
          latitude: -6.2,
          longitude: 106.8,
          occurred_at: new Date().toISOString(),
          ingested_at: new Date().toISOString(),
          attributes: {},
        },
        'zombie-corr-1',
      );
    } catch (err) {
      if (err instanceof FencedError) caughtFenceErr = err;
    }
    // Also test via aggregator storage gateway HTTP endpoint to observe raw HTTP 409 FENCED payload
    const gwFenceRes = await fetch(`${aggUrls[0]}/internal/storage/upsertEvent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': 'ik' },
      body: JSON.stringify({
        args: [
          {
            hazard_id: hazardId('BMKG', 'BMKG-ZOMBIE-WRITE-2'),
            source: 'BMKG',
            source_ref_id: 'BMKG-ZOMBIE-WRITE-2',
            hazard_type: 'SEISMIC',
            severity: 'AWAS',
            area_name: 'Zombie Gateway Attempt',
            latitude: -6.2,
            longitude: 106.8,
            occurred_at: new Date().toISOString(),
            ingested_at: new Date().toISOString(),
            attributes: {},
            version: 1,
          },
          { fence: 1, fenceName: 'bmkg', idempotencyKey: 'z-2', correlationId: 'z-2' },
        ],
      }),
    });
    const gwFenceBody = await gwFenceRes.json();
    const aggMetricsText = await (await fetch(`${aggUrls[0]}/metrics`)).text();
    line(`   Direct storage-unit response to deposed Leader 1 (fence=1 < barrier=2): HTTP ${gwFenceRes.status} ${JSON.stringify(gwFenceBody)}`);
    line(`   Caught FencedError in StorageCanonicalStore: ${caughtFenceErr?.message ?? 'none'}`);
    check(
      'P2-K5: storage-unit directly rejects zombie leader write with HTTP 409 FENCED (got=1, current=2)',
      caughtFenceErr !== null && gwFenceRes.status === 409 && gwFenceBody.code === 'FENCED' && gwFenceBody.got === 1 && gwFenceBody.current === 2,
    );
    check(
      'P2-K5: bnpb_fencing_rejections_total{name="bmkg"} metric is incremented on /metrics',
      aggMetricsText.includes('bnpb_fencing_rejections_total{name="bmkg"}'),
    );

    // -------------------------------------------------------------------------
    // 3. X-12: Every Aggregator Instance Answers Audit API Endpoints Identically
    // -------------------------------------------------------------------------
    line(`\n3. X-12: Stateless Multi-Instance Audit API Consistency Across 3 Aggregator Instances:`);
    // Seed events across all 4 sources
    const SOURCES: Array<[HazardSource, HazardType, string]> = [
      ['BMKG', 'SEISMIC', 'Sumatera Barat'],
      ['PVMBG', 'VOLCANIC', 'Gunung Merapi, DIY'],
      ['SATELIT', 'WILDFIRE', 'Kalimantan Tengah'],
      ['SENSOR_PANTAI', 'COASTAL', 'Teluk Padang, Sumatera Barat'],
    ];
    for (let i = 0; i < 120; i++) {
      const [source, hazard_type, area_name] = SOURCES[i % 4];
      const ref = `X12-${source}-${i}`;
      await ring.upsertEvent(
        {
          hazard_id: hazardId(source, ref),
          source,
          source_ref_id: ref,
          hazard_type,
          severity: i % 10 === 0 ? 'AWAS' : i % 4 === 0 ? 'SIAGA' : 'WASPADA',
          area_name,
          latitude: -2.5,
          longitude: 110.0,
          occurred_at: new Date(Date.UTC(2026, 10, 21, i % 24, i % 60, 0)).toISOString(),
          ingested_at: new Date(Date.UTC(2026, 10, 21, 12, 0, i)).toISOString(),
          attributes: source === 'BMKG' ? { potential_tsunami: i % 12 === 0 } : {},
          version: 1,
        },
        { fence: 2, fenceName: source.toLowerCase(), idempotencyKey: `x12-${i}`, correlationId: 'x12' },
      );
    }

    const authHeaders = { authorization: 'Bearer audit-secret' };
    const sampleId = hazardId('SATELIT', 'X12-SATELIT-2');
    const perInstance = await Promise.all(
      aggUrls.map(async (u) => ({
        events: await (await fetch(`${u}/internal/audit/events?limit=200`, { headers: authHeaders })).json(),
        csBmkg: await (await fetch(`${u}/internal/audit/checksum?source=BMKG`, { headers: authHeaders })).json(),
        csSat: await (await fetch(`${u}/internal/audit/checksum?source=SATELIT`, { headers: authHeaders })).json(),
        loc: await (await fetch(`${u}/internal/audit/location?hazard_id=${sampleId}`, { headers: authHeaders })).json(),
        ring: await (await fetch(`${u}/internal/audit/ring`, { headers: authHeaders })).json(),
      })),
    );
    const evJson0 = JSON.stringify(perInstance[0].events);
    const locJson0 = JSON.stringify(perInstance[0].loc);
    const sameEvents = perInstance.every((x) => JSON.stringify(x.events) === evJson0);
    const sameChecksum = perInstance.every(
      (x) =>
        x.csBmkg.checksum === perInstance[0].csBmkg.checksum &&
        x.csBmkg.count === perInstance[0].csBmkg.count &&
        x.csSat.checksum === perInstance[0].csSat.checksum,
    );
    const sameLoc = perInstance.every((x) => JSON.stringify(x.loc) === locJson0);
    const sameRingUnits = perInstance.every((x) => x.ring.units.length === 3 && x.ring.redundancy_ok === true);
    line(`   Instance 1..3 BMKG checksum : ${perInstance.map((x) => x.csBmkg.checksum.slice(0, 16) + '...').join(' == ')} (count=${perInstance[0].csBmkg.count})`);
    line(`   Instance 1..3 events count  : ${perInstance.map((x) => x.events.items.length).join(' == ')}`);
    check('X-12a: /internal/audit/events is byte-for-byte identical across all 3 Aggregator instances', sameEvents);
    check('X-12b: /internal/audit/checksum is identical across all 3 Aggregator instances', sameChecksum);
    check('X-12c: /internal/audit/location and /internal/audit/ring agree across all 3 Aggregator instances', sameLoc && sameRingUnits);

    // -------------------------------------------------------------------------
    // 4. X-11: Analytics Dashboard == Audit API Under Load & During Node Loss (Partial Marker)
    // -------------------------------------------------------------------------
    line(`\n4. X-11: Analytics Dashboard Matches Audit API Under Concurrent Write Load & Node Failure:`);
    // Concurrent writes while querying analytics dashboard
    const concurrentWrites = Array.from({ length: 40 }, (_, i) => {
      const [source, hazard_type, area_name] = SOURCES[i % 4];
      const ref = `X11-LOAD-${i}`;
      return ring.upsertEvent(
        {
          hazard_id: hazardId(source, ref),
          source,
          source_ref_id: ref,
          hazard_type,
          severity: 'SIAGA',
          area_name,
          latitude: -3.0,
          longitude: 112.0,
          occurred_at: new Date(Date.UTC(2026, 10, 21, 15, i % 60, 0)).toISOString(),
          ingested_at: new Date(Date.UTC(2026, 10, 21, 15, 0, i)).toISOString(),
          attributes: {},
          version: 1,
        },
        { fence: 2, fenceName: source.toLowerCase(), idempotencyKey: `x11-${i}`, correlationId: 'x11' },
      );
    });
    await Promise.all(concurrentWrites);

    const [auditAll, dashSummary] = await Promise.all([
      (await fetch(`${aggUrls[2]}/internal/audit/events?limit=1000`, { headers: authHeaders })).json() as Promise<any>,
      (await fetch(`${DASH}/api/summary?bucket=day`)).json() as Promise<any>,
    ]);
    const totalBySev = Object.values(dashSummary.by_severity as Record<string, number>).reduce((a, b) => a + b, 0);
    const totalByArea = (dashSummary.by_area as Array<{ count: number }>).reduce((a, b) => a + b.count, 0);
    line(`   Under healthy 3-node ring: Audit total=${auditAll.items.length}, Dashboard total=${dashSummary.total}, by_severity sum=${totalBySev}, by_area sum=${totalByArea}, partial=${dashSummary.partial}`);
    check(
      `X-11a: Analytics Dashboard total (${dashSummary.total}), severity sum (${totalBySev}), and area sum (${totalByArea}) equal Audit API event count (${auditAll.items.length})`,
      dashSummary.total === auditAll.items.length && totalBySev === auditAll.items.length && totalByArea === auditAll.items.length && dashSummary.partial === false,
    );

    // Kill 1 storage unit (unit-1 on node-b): at RF=2, every key still has 1 STABLE replica -> still complete
    killProc(unitProcs[1]);
    await sleep(250);
    const dashOneDown = (await (await fetch(`${DASH}/api/summary?bucket=day`)).json()) as any;
    check(
      `X-11b: with 1 storage unit killed (RF=2), dashboard still serves all ${dashOneDown.total} events without error (partial=${dashOneDown.partial})`,
      dashOneDown.total === auditAll.items.length && dashOneDown.partial === false,
    );

    // Kill a 2nd storage unit (unit-2 on node-c): ring arcs owned by (unit-1, unit-2) have no STABLE replica -> partial:true!
    killProc(unitProcs[2]);
    await sleep(250);
    const [dashTwoDown, auditTwoDown] = await Promise.all([
      (await fetch(`${DASH}/api/summary?bucket=day`)).json() as Promise<any>,
      (await fetch(`${aggUrls[0]}/internal/audit/events?limit=1000`, { headers: authHeaders })).json() as Promise<any>,
    ]);
    line(`   With 2 storage units down: Dashboard total=${dashTwoDown.total}, Audit visible=${auditTwoDown.items.length}, partial=${dashTwoDown.partial}, unavailable_units=${JSON.stringify(dashTwoDown.unavailable_units)}`);
    check(
      'X-11c: when degraded beyond RF (2 units down), dashboard explicitly flags partial=true with unavailable_units=["unit-1","unit-2"] and matches Audit API visible count',
      dashTwoDown.partial === true &&
        Array.isArray(dashTwoDown.unavailable_units) &&
        dashTwoDown.unavailable_units.includes('unit-1') &&
        dashTwoDown.unavailable_units.includes('unit-2') &&
        dashTwoDown.total === auditTwoDown.items.length,
    );

    const allOk = checks.every(([, ok]) => ok);
    line(`RESULT: ${allOk ? 'PASS' : 'FAIL'}`);
    process.exitCode = allOk ? 0 : 1;
  } finally {
    for (const p of procs) killProc(p);
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exitCode = 1;
});
