import { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HazardEvent } from '../../../../shared-types/src/hazard-event';
import { PostgresCanonicalStore } from './canonical-store';

vi.mock('pg', () => ({ Pool: vi.fn() }));

const event: HazardEvent = {
  hazard_id: 'd10f5efe-be09-40ad-b681-4e38f93e55db',
  source: 'BMKG', source_ref_id: 'transaction-test', hazard_type: 'SEISMIC', severity: 'SIAGA',
  area_name: 'Test Region', latitude: -6.2, longitude: 106.8,
  occurred_at: '2026-09-26T10:00:00.000Z', ingested_at: '2026-09-26T10:00:01.000Z',
  attributes: { magnitude: 6.6 },
};

function database(created: boolean, failOutbox = false) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('INSERT INTO hazard_events')) {
      return { rows: [{ ...event, occurred_at: new Date(event.occurred_at), ingested_at: new Date(event.ingested_at), created }] };
    }
    if (sql.includes('INSERT INTO hazard_event_outbox') && failOutbox) throw new Error('outbox insert failed');
    return { rows: [] };
  });
  const release = vi.fn();
  vi.mocked(Pool).mockImplementation(() => ({ connect: vi.fn(async () => ({ query, release })) }) as never);
  return { query, release };
}

beforeEach(() => vi.clearAllMocks());

describe('PostgresCanonicalStore outbox transaction', () => {
  it('commits a new HazardEvent and its publication intent in one transaction', async () => {
    const { query, release } = database(true);
    const result = await new PostgresCanonicalStore('postgres://test').upsert(event, 'corr-42');

    expect(result.created).toBe(true);
    expect(query.mock.calls.map(([sql]) => sql.trim().split(/\s+/)[0])).toEqual(['BEGIN', 'INSERT', 'INSERT', 'COMMIT']);
    expect(query.mock.calls[2][1]).toEqual(expect.arrayContaining([event.hazard_id, 'corr-42']));
    expect(release).toHaveBeenCalledOnce();
  });

  it('rolls back the HazardEvent insert when outbox insertion fails', async () => {
    const { query, release } = database(true, true);
    await expect(new PostgresCanonicalStore('postgres://test').upsert(event, 'corr-42')).rejects.toThrow('outbox insert failed');

    expect(query.mock.calls.map(([sql]) => sql.trim().split(/\s+/)[0])).toEqual(['BEGIN', 'INSERT', 'INSERT', 'ROLLBACK']);
    expect(release).toHaveBeenCalledOnce();
  });

  it('does not enqueue a duplicate when a source record already exists', async () => {
    const { query } = database(false);
    const result = await new PostgresCanonicalStore('postgres://test').upsert(event, 'corr-42');

    expect(result.created).toBe(false);
    expect(query.mock.calls.map(([sql]) => sql.trim().split(/\s+/)[0])).toEqual(['BEGIN', 'INSERT', 'COMMIT']);
  });
});
