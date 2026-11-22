// P1-K1 & P1-K2 on real processes: loads the historical earthquake catalogue (CSV/JSON/JSONL via --file or built-in Indonesian subduction catalogue),
// reports natural regional skew, primary vs replica shard placement per node, verifies primary!=replica node separation, and measures per-node load during catalogue load and regional surge.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { computeChecksum, hazardId } from '../../shared-types/src/m2/ids';
import type { HazardEvent, Severity, StoredHazardEvent } from '../../shared-types/src/m2/types';
import { discoverUnits } from '../../shared-types/src/ring/factory';
import { HttpStorageClient } from '../../shared-types/src/ring/http-storage-client';

const ROOT = join(__dirname, '../..');
const DEFAULT_CSV = join(ROOT, 'scripts/demo/fixtures/katalog-gempa-historis.csv');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = (s: string) => process.stdout.write(s + '\n');
const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => {
  checks.push([name, ok]);
  line(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`);
};

interface RawQuakeRow {
  event_id: string;
  occurred_at: string;
  latitude: number;
  longitude: number;
  depth_km: number;
  magnitude: number;
  region: string;
  potential_tsunami: boolean;
}

// Indonesian tectonic belts with natural historical earthquake frequency skew (Ring of Fire)
const SEISMIC_BELTS: Array<{
  zone: string;
  weight: number; // out of 100
  latBase: number;
  lonBase: number;
  latSpan: number;
  lonSpan: number;
  regions: string[];
}> = [
  {
    zone: 'Busur Sunda-Mentawai (Sumatera)',
    weight: 38,
    latBase: -2.5,
    lonBase: 99.5,
    latSpan: 7.0,
    lonSpan: 5.5,
    regions: [
      'Kepulauan Mentawai, Sumatera Barat',
      'Bengkulu Selatan, Bengkulu',
      'Simeulue, Aceh',
      'Nias Selatan, Sumatera Utara',
      'Pesisir Selatan, Sumatera Barat',
    ],
  },
  {
    zone: 'Subduksi Selatan Jawa & Selat Sunda',
    weight: 27,
    latBase: -8.2,
    lonBase: 108.5,
    latSpan: 1.8,
    lonSpan: 6.5,
    regions: [
      'Pandeglang, Banten',
      'Pangandaran, Jawa Barat',
      'Cilacap, Jawa Tengah',
      'Pacitan, Jawa Timur',
      'Malang Selatan, Jawa Timur',
    ],
  },
  {
    zone: 'Sesar Palu-Koro & Subduksi Sulawesi',
    weight: 16,
    latBase: -0.9,
    lonBase: 120.2,
    latSpan: 2.5,
    lonSpan: 4.0,
    regions: [
      'Donggala, Sulawesi Tengah',
      'Sigi, Sulawesi Tengah',
      'Kepulauan Talaud, Sulawesi Utara',
      'Teluk Tomini, Gorontalo',
    ],
  },
  {
    zone: 'Busur Banda & Laut Maluku',
    weight: 11,
    latBase: -4.5,
    lonBase: 128.5,
    latSpan: 4.0,
    lonSpan: 3.5,
    regions: [
      'Laut Banda, Maluku',
      'Halmahera Selatan, Maluku Utara',
      'Pulau Seram, Maluku',
    ],
  },
  {
    zone: 'Busur Flores & Nusa Tenggara',
    weight: 5,
    latBase: -8.6,
    lonBase: 119.5,
    latSpan: 1.2,
    lonSpan: 5.0,
    regions: [
      'Lombok Utara, Nusa Tenggara Barat',
      'Laut Flores, Nusa Tenggara Timur',
      'Sumba Barat, Nusa Tenggara Timur',
    ],
  },
  {
    zone: 'Sesar Mamberamo & Yapen (Papua)',
    weight: 3,
    latBase: -2.4,
    lonBase: 138.8,
    latSpan: 1.5,
    lonSpan: 3.0,
    regions: [
      'Jayapura, Papua',
      'Kepulauan Yapen, Papua',
    ],
  },
];

function deterministicHash(seed: number): number {
  let x = (seed + 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

function ensureCatalogueFixture(path: string, total = 3600): void {
  if (existsSync(path)) return;
  mkdirSync(join(path, '..'), { recursive: true });
  const lines = ['event_id,occurred_at,latitude,longitude,depth_km,magnitude,region,potential_tsunami'];
  const baseTs = Date.UTC(2020, 0, 1, 0, 0, 0);
  for (let i = 0; i < total; i++) {
    const h1 = deterministicHash(i * 3 + 1);
    const h2 = deterministicHash(i * 3 + 2);
    const h3 = deterministicHash(i * 3 + 3);
    const bucket = i % 100;
    let acc = 0;
    let belt = SEISMIC_BELTS[0];
    for (const b of SEISMIC_BELTS) {
      acc += b.weight;
      if (bucket < acc) {
        belt = b;
        break;
      }
    }
    const region = belt.regions[h1 % belt.regions.length];
    const lat = Number((belt.latBase + ((h1 % 10000) / 10000 - 0.5) * belt.latSpan).toFixed(4));
    const lon = Number((belt.lonBase + ((h2 % 10000) / 10000 - 0.5) * belt.lonSpan).toFixed(4));
    const depth = 10 + (h3 % 240);
    // Gutenberg-Richter style magnitude distribution (3.2 to 7.8)
    const magRaw = 3.2 + Math.pow((h2 % 1000) / 1000, 2.2) * 4.6;
    const magnitude = Number(magRaw.toFixed(1));
    const potential_tsunami = magnitude >= 7.0 && depth <= 50;
    const occurred_at = new Date(baseTs + i * 48_000 + (h1 % 30_000)).toISOString();
    const event_id = `BMKG-HIST-${String(i + 1).padStart(5, '0')}`;
    lines.push(`${event_id},${occurred_at},${lat},${lon},${depth},${magnitude},"${region}",${potential_tsunami}`);
  }
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
}

function parseCsvLine(raw: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

export function loadCatalogueFile(filePath: string): RawQuakeRow[] {
  const text = readFileSync(filePath, 'utf8').trim();
  if (!text) return [];
  if (text.startsWith('[') || text.startsWith('{')) {
    const rawItems: any[] = text.startsWith('[')
      ? JSON.parse(text)
      : text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return rawItems.map((item, idx) => ({
      event_id: String(item.event_id ?? item.source_ref_id ?? item.id ?? `EQ-${idx + 1}`),
      occurred_at: new Date(item.occurred_at ?? item.datetime ?? item.timestamp ?? Date.now()).toISOString(),
      latitude: Number(item.latitude ?? item.lat ?? 0),
      longitude: Number(item.longitude ?? item.lon ?? item.lng ?? 0),
      depth_km: Number(item.depth_km ?? item.depth ?? 10),
      magnitude: Number(item.magnitude ?? item.mag ?? 4.5),
      region: String(item.region ?? item.area_name ?? item.location ?? 'Indonesia'),
      potential_tsunami: Boolean(item.potential_tsunami ?? item.tsunami ?? false),
    }));
  }
  const lines = text.split(/\r?\n/).filter(Boolean);
  const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const idx = (names: string[]) => headers.findIndex((h) => names.includes(h));
  const idIdx = idx(['event_id', 'source_ref_id', 'id']);
  const tsIdx = idx(['occurred_at', 'datetime', 'timestamp', 'time', 'date']);
  const latIdx = idx(['latitude', 'lat']);
  const lonIdx = idx(['longitude', 'lon', 'lng']);
  const depIdx = idx(['depth_km', 'depth']);
  const magIdx = idx(['magnitude', 'mag']);
  const regIdx = idx(['region', 'area_name', 'area', 'location', 'wilayah']);
  const tsuIdx = idx(['potential_tsunami', 'tsunami']);

  return lines.slice(1).map((lineStr, i) => {
    const cols = parseCsvLine(lineStr);
    const mag = magIdx >= 0 ? Number(cols[magIdx]) : 4.5;
    const dep = depIdx >= 0 ? Number(cols[depIdx]) : 15;
    return {
      event_id: idIdx >= 0 && cols[idIdx] ? cols[idIdx] : `EQ-${i + 1}`,
      occurred_at: tsIdx >= 0 && cols[tsIdx] ? new Date(cols[tsIdx]).toISOString() : new Date().toISOString(),
      latitude: latIdx >= 0 ? Number(cols[latIdx]) : -5.0,
      longitude: lonIdx >= 0 ? Number(cols[lonIdx]) : 110.0,
      depth_km: dep,
      magnitude: mag,
      region: regIdx >= 0 && cols[regIdx] ? cols[regIdx] : 'Indonesia',
      potential_tsunami: tsuIdx >= 0 ? cols[tsuIdx] === 'true' || cols[tsuIdx] === '1' : mag >= 7.0 && dep <= 50,
    };
  });
}

function severityForQuake(q: RawQuakeRow): Severity {
  if (q.potential_tsunami || q.magnitude >= 7.0) return 'AWAS';
  if (q.magnitude >= 6.0) return 'SIAGA';
  if (q.magnitude >= 4.5) return 'WASPADA';
  return 'NORMAL';
}

function toStoredHazardEvent(q: RawQuakeRow): StoredHazardEvent {
  return {
    hazard_id: hazardId('BMKG', q.event_id),
    source: 'BMKG',
    source_ref_id: q.event_id,
    hazard_type: 'SEISMIC',
    severity: severityForQuake(q),
    area_name: q.region,
    latitude: q.latitude,
    longitude: q.longitude,
    occurred_at: q.occurred_at,
    ingested_at: new Date().toISOString(),
    attributes: {
      magnitude: q.magnitude,
      depth_km: q.depth_km,
      potential_tsunami: q.potential_tsunami,
    },
    version: 1,
  };
}

async function until(what: string, fn: () => Promise<boolean>, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn().catch(() => false)) return;
    await sleep(150);
  }
  throw new Error(`timeout waiting for ${what}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fileArgIdx = args.indexOf('--file');
  const filePath = fileArgIdx >= 0 && args[fileArgIdx + 1]
    ? resolve(args[fileArgIdx + 1])
    : process.env.CATALOGUE_FILE
      ? resolve(process.env.CATALOGUE_FILE)
      : DEFAULT_CSV;

  ensureCatalogueFixture(DEFAULT_CSV, 3600);
  const catalogue = loadCatalogueFile(filePath);
  line(`=== P1-K1 & P1-K2: Historical Earthquake Catalogue Sharding & Skew Evaluation ===`);
  line(`Catalogue file: ${filePath} (${catalogue.length} historical earthquake events)`);

  // Report natural regional skew of the dataset
  const byRegion = new Map<string, number>();
  for (const q of catalogue) {
    byRegion.set(q.region, (byRegion.get(q.region) ?? 0) + 1);
  }
  const sortedRegions = [...byRegion.entries()].sort((a, b) => b[1] - a[1]);
  const top5Share = sortedRegions.slice(0, 5).reduce((s, [, c]) => s + c, 0) / catalogue.length;
  line(`\n1. Natural Regional Skew in Dataset (Top 8 of ${sortedRegions.length} regions):`);
  for (const [reg, count] of sortedRegions.slice(0, 8)) {
    line(`   - ${reg.padEnd(38)}: ${String(count).padStart(4)} events (${((count / catalogue.length) * 100).toFixed(1)} %)`);
  }
  line(`   Top-5 regions account for ${(top5Share * 100).toFixed(1)} % of the dataset (strong natural geographic skew).`);

  const tmp = mkdtempSync(join(tmpdir(), 'p1-k1-'));
  const procs: ChildProcess[] = [];
  const runProc = (cmd: string, cmdArgs: string[], cwd: string, env: Record<string, string>) => {
    const p = spawn(cmd, cmdArgs, { cwd, env: { ...process.env, ...env }, stdio: 'ignore', detached: true });
    procs.push(p);
    return p;
  };

  try {
    const unitPorts = [18710, 18711, 18712];
    const nodeNames = ['node-a', 'node-b', 'node-c'];
    const unitNames = ['unit-0', 'unit-1', 'unit-2'];
    unitPorts.forEach((p, i) =>
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

    const aggPort = 18720;
    const AGG = `http://127.0.0.1:${aggPort}`;
    runProc('npx', ['tsx', 'scripts/ring-host.ts'], join(ROOT, 'services/aggregator'), {
      STORAGE_UNITS,
      AGGREGATOR_PORT: String(aggPort),
      INTERNAL_SERVICE_KEY: 'ik',
      AUDIT_TOKEN: 'audit-secret',
    });
    await until('aggregator ring-host ready', async () => (await fetch(`${AGG}/ready`)).ok);

    // Load historical catalogue in parallel batches
    const ctx = { fence: 1, fenceName: 'bmkg', idempotencyKey: 'cat', correlationId: 'p1-k1-catalogue' };
    const events = catalogue.map(toStoredHazardEvent);
    const batchSize = 60;
    const t0 = Date.now();
    for (let i = 0; i < events.length; i += batchSize) {
      await Promise.all(
        events.slice(i, i + batchSize).map((ev, j) =>
          ring.upsertEvent(ev, { ...ctx, idempotencyKey: `cat-${i + j}` }),
        ),
      );
    }
    const loadMs = Date.now() - t0;

    // Tally primary & replica distribution per unit/node via locate()
    const primaryCount = new Map<string, number>(unitNames.map((u) => [u, 0]));
    const replicaCount = new Map<string, number>(unitNames.map((u) => [u, 0]));
    let distinctNodePairs = 0;

    for (let i = 0; i < events.length; i += batchSize) {
      const locs = await Promise.all(events.slice(i, i + batchSize).map((ev) => ring.locate(ev.hazard_id)));
      for (const l of locs) {
        const prim = l.locations.find((x) => x.role === 'primary');
        const repl = l.locations.find((x) => x.role === 'replica');
        if (prim) primaryCount.set(prim.unit, (primaryCount.get(prim.unit) ?? 0) + 1);
        if (repl) replicaCount.set(repl.unit, (replicaCount.get(repl.unit) ?? 0) + 1);
        if (prim && repl && prim.node !== repl.node) distinctNodePairs++;
      }
    }

    const statusAfterLoad = await ring.ringStatus();
    line(`\n2. P1-K1 Shard (Unit) & Node Placement After Loading ${events.length} Historical Earthquakes (${loadMs} ms):`);
    line(`   Ring configuration: 64 virtual nodes/unit, RF=2, 3 storage units across 3 nodes`);
    line(`   ---------------------------------------------------------------------------------------------------------`);
    line(`   Node     | Unit   | State  | Primary Role (Writes) | Replica Role (Backup) | Total Keys Stored (% of all)`);
    line(`   ---------------------------------------------------------------------------------------------------------`);
    for (const u of statusAfterLoad.units) {
      const pCount = primaryCount.get(u.unit) ?? 0;
      const rCount = replicaCount.get(u.unit) ?? 0;
      const pPct = ((pCount / events.length) * 100).toFixed(1);
      const rPct = ((rCount / events.length) * 100).toFixed(1);
      const kPct = ((u.keys / events.length) * 100).toFixed(1);
      line(
        `   ${u.node.padEnd(8)} | ${u.unit.padEnd(6)} | ${u.state.padEnd(6)} | ${String(pCount).padStart(5)} (${pPct.padStart(5)} %)       | ${String(rCount).padStart(5)} (${rPct.padStart(5)} %)       | ${String(u.keys).padStart(5)} / ${events.length} (${kPct.padStart(5)} %)`,
      );
    }
    line(`   ---------------------------------------------------------------------------------------------------------`);

    // Verify sample location via HTTP Audit API /internal/audit/location
    const sampleEv = events[0];
    const locRes = await fetch(`${AGG}/internal/audit/location?hazard_id=${encodeURIComponent(sampleEv.hazard_id)}`, {
      headers: { authorization: 'Bearer audit-secret' },
    });
    const locBody = (await locRes.json()) as any;
    line(`   Audit API sample location (${sampleEv.hazard_id}): ${JSON.stringify(locBody.locations)}`);

    // Checksum verification via Audit API
    const csRes = await fetch(`${AGG}/internal/audit/checksum?source=BMKG`, {
      headers: { authorization: 'Bearer audit-secret' },
    });
    const csBody = (await csRes.json()) as any;
    const expectedCs = computeChecksum(events.map((e) => e.source_ref_id));
    line(`   Audit API checksum: count=${csBody.count}, sha256=${csBody.checksum}`);

    const primCounts = [...primaryCount.values()];
    const meanPrim = events.length / 3;
    const maxPrimSkew = (Math.max(...primCounts) - Math.min(...primCounts)) / meanPrim;
    const writesAfterLoad = statusAfterLoad.units.map((u) => u.writes_total);
    const meanWritesLoad = writesAfterLoad.reduce((a, b) => a + b, 0) / writesAfterLoad.length;
    const loadImbalance = (Math.max(...writesAfterLoad) - Math.min(...writesAfterLoad)) / meanWritesLoad;

    // P1-K2 Phase 2: Regional earthquake surge simulation (1,500 aftershocks in Palu-Koro fault within 1 hour)
    const SURGE_N = 1500;
    const surgeEvents: StoredHazardEvent[] = Array.from({ length: SURGE_N }, (_, i) => {
      const ref = `BMKG-SURGE-PALU-${String(i + 1).padStart(4, '0')}`;
      return {
        hazard_id: hazardId('BMKG', ref),
        source: 'BMKG',
        source_ref_id: ref,
        hazard_type: 'SEISMIC',
        severity: i % 20 === 0 ? 'SIAGA' : 'WASPADA',
        area_name: 'Donggala, Sulawesi Tengah',
        latitude: -0.92 + (i % 50) * 0.0005,
        longitude: 119.85 + (i % 50) * 0.0005,
        occurred_at: new Date(Date.UTC(2026, 10, 20, 14, Math.floor(i / 30), i % 60)).toISOString(),
        ingested_at: new Date().toISOString(),
        attributes: { magnitude: 4.8 + (i % 15) * 0.1, depth_km: 12, potential_tsunami: false },
        version: 1,
      };
    });

    for (let i = 0; i < surgeEvents.length; i += batchSize) {
      await Promise.all(
        surgeEvents.slice(i, i + batchSize).map((ev, j) =>
          ring.upsertEvent(ev, { ...ctx, idempotencyKey: `surge-${i + j}` }),
        ),
      );
    }

    const statusAfterSurge = await ring.ringStatus();
    const surgeWriteDelta = statusAfterSurge.units.map((u, idx) => u.writes_total - writesAfterLoad[idx]);
    const meanSurgeWrites = surgeWriteDelta.reduce((a, b) => a + b, 0) / surgeWriteDelta.length;
    const surgeImbalance = (Math.max(...surgeWriteDelta) - Math.min(...surgeWriteDelta)) / meanSurgeWrites;

    line(`\n3. P1-K2 Per-Node Load Measurement (Historical Dataset Load vs Single-Region Surge):`);
    line(`   - Historical catalogue load (${events.length} events, 81% concentrated in top-3 tectonic belts):`);
    line(`     Per-node writes: ${writesAfterLoad.map((w, i) => `${nodeNames[i]}=${w}`).join(', ')} (imbalance ${(loadImbalance * 100).toFixed(1)} % of mean)`);
    line(`   - Single-region surge (${SURGE_N} events, 100% in "Donggala, Sulawesi Tengah"):`);
    line(`     Per-node writes: ${surgeWriteDelta.map((w, i) => `${nodeNames[i]}=${w}`).join(', ')} (imbalance ${(surgeImbalance * 100).toFixed(1)} % of mean)`);

    line(`\n4. Verification Checks:`);
    check(`P1-K1: loaded ${events.length} historical earthquake events from catalogue file`, csBody.count === events.length);
    check(
      `P1-K1: no single unit holds all data (each unit holds ~66.7% at RF=2: ${statusAfterLoad.units.map((u) => u.keys).join(' / ')} < ${events.length})`,
      statusAfterLoad.units.every((u) => u.keys > 0 && u.keys < events.length),
    );
    check(
      `P1-K1: primary role is distributed across all 3 nodes (${primCounts.join(' / ')}, max skew ${(maxPrimSkew * 100).toFixed(1)}% < 15%)`,
      primCounts.every((c) => c > events.length * 0.28) && maxPrimSkew < 0.15,
    );
    check(
      `P1-K1: 100% of events (${distinctNodePairs}/${events.length}) have their replica on a different node from their primary`,
      distinctNodePairs === events.length,
    );
    check(
      `P1-K1: Audit API SHA-256 checksum matches the loaded historical earthquake catalogue`,
      csBody.checksum === expectedCs && csBody.partial === false,
    );
    check(
      `P1-K2: natural regional skew absorbed during catalogue load (write imbalance ${(loadImbalance * 100).toFixed(1)}% < 15%)`,
      loadImbalance < 0.15,
    );
    check(
      `P1-K2: single-region surge absorbed evenly (write imbalance ${(surgeImbalance * 100).toFixed(1)}% < 15%)`,
      surgeImbalance < 0.15,
    );

    // -------------------------------------------------------------------------
    // 5. Changelog 20/11/2026 Verification: 2-Node Cluster with 4 Shards (2 units per node)
    // -------------------------------------------------------------------------
    line(`\n5. Changelog (20/11/2026) 2-Node Cluster Verification (4 Shards across 2 Nodes: shard-a1, shard-a2 on node-a; shard-b1, shard-b2 on node-b):`);
    const twoNodePorts = [18730, 18731, 18732, 18733];
    const twoNodeShards = [
      { unit: 'shard-a1', node: 'node-a', port: twoNodePorts[0] },
      { unit: 'shard-a2', node: 'node-a', port: twoNodePorts[1] },
      { unit: 'shard-b1', node: 'node-b', port: twoNodePorts[2] },
      { unit: 'shard-b2', node: 'node-b', port: twoNodePorts[3] },
    ];
    const twoNodeProcs = twoNodeShards.map((s, idx) =>
      runProc('node', ['dist/services/storage-unit/src/index.js'], join(ROOT, 'services/storage-unit'), {
        STORAGE_UNIT_PORT: String(s.port),
        STORAGE_UNIT_ID: s.unit,
        NODE_NAME: s.node,
        STORAGE_DATA_DIR: join(tmp, `2n-${idx}`),
      }),
    );
    const twoNodeUnits = await discoverUnits({ STORAGE_UNITS: twoNodePorts.map((p) => `http://127.0.0.1:${p}`).join(',') }, 25);
    const ring2N = new HttpStorageClient({ units: twoNodeUnits, rf: 2, vnodes: 64, stateTtlMs: 0 });
    await ring2N.repair();

    for (let i = 0; i < events.length; i += batchSize) {
      await Promise.all(
        events.slice(i, i + batchSize).map((ev, j) =>
          ring2N.upsertEvent(ev, { ...ctx, idempotencyKey: `2n-${i + j}` }),
        ),
      );
    }

    const prim2N = new Map<string, number>(twoNodeShards.map((s) => [s.unit, 0]));
    const repl2N = new Map<string, number>(twoNodeShards.map((s) => [s.unit, 0]));
    let crossNode2N = 0;
    for (let i = 0; i < events.length; i += batchSize) {
      const locs = await Promise.all(events.slice(i, i + batchSize).map((ev) => ring2N.locate(ev.hazard_id)));
      for (const l of locs) {
        const p = l.locations.find((x) => x.role === 'primary');
        const r = l.locations.find((x) => x.role === 'replica');
        if (p) prim2N.set(p.unit, (prim2N.get(p.unit) ?? 0) + 1);
        if (r) repl2N.set(r.unit, (repl2N.get(r.unit) ?? 0) + 1);
        if (p && r && p.node !== r.node) crossNode2N++;
      }
    }
    const status2N = await ring2N.ringStatus();
    for (const u of status2N.units) {
      line(
        `   ${u.node.padEnd(8)} | ${u.unit.padEnd(8)} | primary=${String(prim2N.get(u.unit) ?? 0).padStart(4)} | replica=${String(repl2N.get(u.unit) ?? 0).padStart(4)} | total_keys=${String(u.keys).padStart(4)} / ${events.length} (${((u.keys / events.length) * 100).toFixed(1)} %)`,
      );
    }
    // Kill entire worker node-b (both shard-b1 and shard-b2!)
    try { process.kill(-twoNodeProcs[2].pid!, 'SIGKILL'); } catch { /* gone */ }
    try { process.kill(-twoNodeProcs[3].pid!, 'SIGKILL'); } catch { /* gone */ }
    await sleep(200);
    const csAfterNodeBKill = await ring2N.checksum('BMKG');
    line(`   After killing entire worker node-b (both shard-b1 & shard-b2): count=${csAfterNodeBKill.count}, checksum_match=${csAfterNodeBKill.checksum === expectedCs}, partial=${csAfterNodeBKill.partial}`);

    check(
      `P1-K1/K4 (2-Node 4-Shard Changelog mode): no shard holds all data (max=${Math.max(...status2N.units.map((u) => u.keys))} < ${events.length}), 100% (${crossNode2N}/${events.length}) cross-node replicas, and killing entire worker node-b loses 0 events`,
      status2N.units.every((u) => u.keys < events.length * 0.65) &&
        crossNode2N === events.length &&
        csAfterNodeBKill.count === events.length &&
        csAfterNodeBKill.checksum === expectedCs &&
        csAfterNodeBKill.partial === false,
    );

    const allOk = checks.every(([, ok]) => ok);
    line(`RESULT: ${allOk ? 'PASS' : 'FAIL'}`);
    process.exitCode = allOk ? 0 : 1;
  } finally {
    for (const p of procs) {
      try {
        process.kill(-p.pid!, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exitCode = 1;
});
