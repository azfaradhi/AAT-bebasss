import { promises as dns } from 'node:dns';
import { GatewayStorageClient } from './gateway-client';
import { HttpStorageClient, type UnitInfo } from './http-storage-client';
import type { StorageClient } from '../m2/types';
import type { UnitIdentity } from './protocol';

// Env: STORAGE_UNITS="http://host:8100,http://host2:8100" or STORAGE_UNITS_DNS="storage-unit.<ns>.svc.cluster.local" (+ STORAGE_UNIT_PORT).
// Each unit reports its own id and node name, so only addresses are configured.
async function identify(url: string, timeoutMs: number): Promise<UnitInfo> {
  const res = await fetch(new URL('/u/identity', url), { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`storage unit ${url} answered ${res.status}`);
  const id = (await res.json()) as UnitIdentity;
  return { unit: id.unit, node: id.node, url };
}

export async function discoverUnits(env: NodeJS.ProcessEnv = process.env, attempts = 30): Promise<UnitInfo[]> {
  const port = env.STORAGE_UNIT_PORT ?? '8100';
  for (let i = 0; ; i++) {
    try {
      let urls: string[];
      if (env.STORAGE_UNITS) urls = env.STORAGE_UNITS.split(',').map((s) => s.trim()).filter(Boolean);
      else if (env.STORAGE_UNITS_DNS) urls = (await dns.resolve4(env.STORAGE_UNITS_DNS)).map((ip) => `http://${ip}:${port}`);
      else throw new Error('set STORAGE_UNITS or STORAGE_UNITS_DNS');
      if (urls.length === 0) throw new Error('no storage unit addresses resolved');
      const units = await Promise.all(urls.map((u) => identify(u, 2000)));
      return units.sort((a, b) => a.unit.localeCompare(b.unit));
    } catch (err) {
      if (i + 1 >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

export async function createStorageFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<HttpStorageClient> {
  return new HttpStorageClient({ units: await discoverUnits(env), rf: Number(env.STORAGE_RF ?? 2), stateTtlMs: Number(env.STORAGE_STATE_TTL_MS ?? 1000) });
}

// Runs anti-entropy on an interval; call from exactly one place per process.
export function startRepairLoop(client: HttpStorageClient, intervalMs: number, onError?: (err: unknown) => void): () => void {
  const timer = setInterval(() => { client.repair().catch((e) => onError?.(e)); }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

// STORAGE_GATEWAY_URL (+ INTERNAL_SERVICE_KEY) reaches the ring through the Aggregator; STORAGE_UNITS(_DNS) talks to the units directly
// (Aggregator only, per the store NetworkPolicy). Returns null when neither is set so the caller can fall back to in-memory.
export async function storageFromEnvOrNull(env: NodeJS.ProcessEnv = process.env): Promise<StorageClient | null> {
  if (env.STORAGE_GATEWAY_URL) {
    if (!env.INTERNAL_SERVICE_KEY) throw new Error('INTERNAL_SERVICE_KEY is required with STORAGE_GATEWAY_URL');
    return new GatewayStorageClient({ baseUrl: env.STORAGE_GATEWAY_URL, internalServiceKey: env.INTERNAL_SERVICE_KEY });
  }
  return env.STORAGE_UNITS || env.STORAGE_UNITS_DNS ? createStorageFromEnv(env) : null;
}
