import { describe, expect, it, vi } from 'vitest';
import type { HazardEvent } from '../../../../shared-types/src/hazard-event';
import Fastify from 'fastify';
import { filterFields, rejectForbiddenRawView } from './rbac-filter';

const event: HazardEvent = {
  hazard_id: 'h-1',
  source: 'BMKG',
  source_ref_id: 'raw-ref',
  hazard_type: 'SEISMIC',
  severity: 'SIAGA',
  area_name: 'Region',
  latitude: -6.1,
  longitude: 106.9,
  occurred_at: '2026-01-01T00:00:00Z',
  ingested_at: '2026-01-01T00:00:01Z',
  attributes: { magnitude: 6.1 },
};

describe('filterFields', () => {
  it('media gets only Ringkasan fields', () => {
    const filtered = filterFields(event, 'media');
    expect(filtered).toEqual({
      hazard_id: 'h-1', source: 'BMKG', hazard_type: 'SEISMIC', severity: 'SIAGA',
      area_name: 'Region', occurred_at: '2026-01-01T00:00:00Z', ingested_at: '2026-01-01T00:00:01Z',
    });
    expect(filtered).not.toHaveProperty('latitude');
    expect(filtered).not.toHaveProperty('attributes');
  });

  it('lapangan and internal get the full event, unfiltered', () => {
    expect(filterFields(event, 'lapangan')).toEqual(event);
    expect(filterFields(event, 'internal')).toEqual(event);
  });
});

describe('rejectForbiddenRawView', () => {
  function app() {
    const a = Fastify({ logger: false });
    a.addHook('preHandler', (request, _reply, done) => {
      (request as never as { clientScope: string }).clientScope = (request.query as { as?: string }).as ?? 'media';
      done();
    });
    const downstream = vi.fn(async () => ({ ok: true }));
    a.get('/x', { preHandler: rejectForbiddenRawView }, downstream);
    return { app: a, downstream };
  }

  it('rejects media + view=raw with 403 FORBIDDEN_FIELD_ACCESS before the handler runs', async () => {
    const { app: a, downstream } = app();
    const res = await a.inject({ method: 'GET', url: '/x?view=raw&as=media' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN_FIELD_ACCESS');
    expect(downstream).not.toHaveBeenCalled();
  });

  it('allows media + view=summary (default) through to the handler', async () => {
    const { app: a, downstream } = app();
    const res = await a.inject({ method: 'GET', url: '/x?as=media' });
    expect(res.statusCode).toBe(200);
    expect(downstream).toHaveBeenCalledTimes(1);
  });

  it('allows lapangan/internal + view=raw through to the handler', async () => {
    for (const scope of ['lapangan', 'internal']) {
      const { app: a, downstream } = app();
      const res = await a.inject({ method: 'GET', url: `/x?view=raw&as=${scope}` });
      expect(res.statusCode).toBe(200);
      expect(downstream).toHaveBeenCalledTimes(1);
    }
  });
});
