import { HttpStorageClient, type UnitFetch, type UnitInfo } from '../../../shared-types/src/ring/http-storage-client';
import type { UnitState } from '../../../shared-types/src/m2/types';
import { buildUnitApp } from './app';
import { UnitEngine } from './engine';

// Three in-process storage units reached through Fastify inject, with switches to simulate failures.
export function makeCluster(opts: { dataDir?: string } = {}) {
  let clock = Date.now();
  const names = ['unit-node-a', 'unit-node-b', 'unit-node-c'];
  const engines = new Map(names.map((n) => [n, new UnitEngine({ unit: n, node: n.replace('unit-', ''), now: () => clock, dataDir: opts.dataDir, initialState: 'STABLE' })]));
  const apps = new Map([...engines].map(([n, e]) => [n, buildUnitApp(e)]));
  const wipe = (unit: string) => {
    const e = new UnitEngine({ unit, node: unit.replace('unit-', ''), now: () => clock, initialState: 'JOINING' });
    engines.set(unit, e);
    apps.set(unit, buildUnitApp(e));
    down.delete(unit);
  };
  const down = new Set<string>();
  const infos: UnitInfo[] = names.map((n) => ({ unit: n, node: n.replace('unit-', ''), url: `http://${n}` }));

  const fetchUnit: UnitFetch = async (u, method, path, body) => {
    if (down.has(u.unit)) throw new Error('connection refused');
    const res = await apps.get(u.unit)!.inject({ method: method as 'GET', url: path, payload: body === undefined ? undefined : (body as object) });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
  const client = new HttpStorageClient({ units: infos, fetchUnit, stateTtlMs: 0, now: () => clock });
  const controls = {
    units: () => names,
    tick: (ms: number) => { clock += ms; },
    setUnitState(unit: string, state: UnitState) {
      if (state === 'DOWN') { down.add(unit); return; }
      down.delete(unit);
      engines.get(unit)!.state = state;
    },
  };
  // A brand-new empty unit (JOINING); hand the returned info to client.addUnits().
  const newUnit = (unit: string): UnitInfo => {
    const e = new UnitEngine({ unit, node: unit.replace('unit-', ''), now: () => clock, initialState: 'JOINING' });
    engines.set(unit, e);
    apps.set(unit, buildUnitApp(e));
    return { unit, node: unit.replace('unit-', ''), url: `http://${unit}` };
  };
  return { client, controls, engines, down, infos, fetchUnit, wipe, newUnit };
}
