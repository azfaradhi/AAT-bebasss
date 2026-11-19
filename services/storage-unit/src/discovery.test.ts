import { describe, expect, it } from 'vitest';
import { discoverUnits } from '../../../shared-types/src/ring/factory';
import { buildUnitApp } from './app';
import { UnitEngine } from './engine';

describe('unit discovery', () => {
  it('learns unit ids and node names from the units themselves, sorted by id', async () => {
    const apps = ['unit-b', 'unit-a'].map((n) => buildUnitApp(new UnitEngine({ unit: n, node: `node-${n.slice(-1)}`, initialState: 'STABLE' })));
    const urls = await Promise.all(apps.map(async (a) => { await a.listen({ port: 0, host: '127.0.0.1' }); const ad = a.server.address(); return `http://127.0.0.1:${typeof ad === 'object' && ad ? ad.port : 0}`; }));
    try {
      const units = await discoverUnits({ STORAGE_UNITS: urls.join(',') }, 1);
      expect(units.map((u) => [u.unit, u.node])).toEqual([['unit-a', 'node-a'], ['unit-b', 'node-b']]);
    } finally { await Promise.all(apps.map((a) => a.close())); }
  });

  it('fails clearly when nothing is configured', async () => {
    await expect(discoverUnits({}, 1)).rejects.toThrow(/STORAGE_UNITS/);
  });
});
