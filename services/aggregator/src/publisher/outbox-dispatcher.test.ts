import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HazardEvent } from '../../../../shared-types/src/hazard-event';
import type { Logger } from '../logger';
import type { CanonicalStore, PendingHazardPublication } from '../storage/canonical-store';
import type { EventPublisher } from './event-publisher';
import { OutboxDispatcher } from './outbox-dispatcher';

const event: HazardEvent = {
  hazard_id: 'c253a90e-2329-4d5e-8cb4-5bd75bf1472d',
  source: 'BMKG', source_ref_id: 'outbox-test', hazard_type: 'SEISMIC', severity: 'SIAGA',
  area_name: 'Test Region', latitude: -6.2, longitude: 106.8,
  occurred_at: '2026-09-26T10:00:00.000Z', ingested_at: '2026-09-26T10:00:01.000Z',
  attributes: { magnitude: 6.6 },
};

const pending: PendingHazardPublication = {
  messageId: 'be4e06c8-58d8-4867-a2e7-b12b9946b84a', correlationId: 'corr-42', event,
};

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

function fakeStore() {
  let queued = true;
  let retryReady = true;
  const store = {
    claimPendingPublication: vi.fn(async () => queued && retryReady ? (retryReady = false, pending) : null),
    markPublicationSent: vi.fn(async () => { queued = false; }),
    releasePublication: vi.fn(async () => { retryReady = true; }),
  };
  return store;
}

beforeEach(() => vi.clearAllMocks());

describe('OutboxDispatcher', () => {
  it('retries an unconfirmed publication after the broker recovers with the same message ID', async () => {
    const store = fakeStore();
    const publish = vi.fn().mockRejectedValueOnce(new Error('broker down')).mockResolvedValue(undefined);
    const firstProcess = new OutboxDispatcher(store as unknown as CanonicalStore, { publish } as EventPublisher, logger);

    await firstProcess.flush();
    expect(store.markPublicationSent).not.toHaveBeenCalled();
    expect(store.releasePublication).toHaveBeenCalledWith(pending.messageId);

    // The persisted outbox is shared by the restarted dispatcher, not its in-memory state.
    const restartedProcess = new OutboxDispatcher(store as unknown as CanonicalStore, { publish } as EventPublisher, logger);
    await restartedProcess.flush();
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenNthCalledWith(1, event, pending.correlationId, pending.messageId);
    expect(publish).toHaveBeenNthCalledWith(2, event, pending.correlationId, pending.messageId);
    expect(store.markPublicationSent).toHaveBeenCalledOnce();
    expect(store.markPublicationSent).toHaveBeenCalledWith(pending.messageId);
  });

  it('does not publish a confirmed row again on later flushes', async () => {
    const store = fakeStore();
    const publish = vi.fn().mockResolvedValue(undefined);
    const dispatcher = new OutboxDispatcher(store as unknown as CanonicalStore, { publish } as EventPublisher, logger);

    await dispatcher.flush();
    await dispatcher.flush();

    expect(publish).toHaveBeenCalledOnce();
    expect(store.markPublicationSent).toHaveBeenCalledOnce();
  });
});
