import { describe, it, expect, vi } from 'vitest';
import { InMemoryStorage } from '../../../../shared-types/src/m2/fakes/in-memory-storage';
import { hazardId } from '../../../../shared-types/src/m2/ids';
import type { CriticalAlertMessage, StoredHazardEvent } from '../../../../shared-types/src/m2/types';
import type { Logger } from '../logger';
import type { EventPublisher } from './event-publisher';
import { OutboxDispatcher } from './outbox-dispatcher';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

describe('M2 OutboxDispatcher over StorageClient with Critical Priority (MB3-T07, MB3-T10, R6)', () => {
  it('dispatches critical outbox items ahead of normal items and survives transient broker outage with 0 lost messages', async () => {
    const storage = new InMemoryStorage();
    await storage.fenceBarrier('pantai', 1);

    const normalEvent: StoredHazardEvent = {
      hazard_id: hazardId('SENSOR_PANTAI', 'obs-normal-1'),
      source: 'SENSOR_PANTAI',
      source_ref_id: 'obs-normal-1',
      hazard_type: 'COASTAL',
      severity: 'WASPADA',
      area_name: 'Padang, Sumatera Barat',
      latitude: -0.99,
      longitude: 100.36,
      occurred_at: '2026-11-12T02:40:00.000Z',
      ingested_at: '2026-11-12T02:40:01.000Z',
      version: 1,
      attributes: { critical: false },
    };

    const criticalEvent: StoredHazardEvent = {
      hazard_id: hazardId('SENSOR_PANTAI', 'obs-crit-1'),
      source: 'SENSOR_PANTAI',
      source_ref_id: 'obs-crit-1',
      hazard_type: 'COASTAL',
      severity: 'AWAS',
      area_name: 'Padang, Sumatera Barat',
      latitude: -0.99,
      longitude: 100.36,
      occurred_at: '2026-11-12T02:41:00.000Z',
      ingested_at: '2026-11-12T02:41:01.000Z',
      version: 1,
      attributes: { critical: true },
    };

    await storage.upsertEvent(normalEvent, {
      fence: 1,
      fenceName: 'pantai',
      idempotencyKey: 'k1',
      correlationId: 'corr-norm',
      outbox: { mode: 'on_create', priority: 'normal' },
    });

    await storage.upsertEvent(criticalEvent, {
      fence: 1,
      fenceName: 'pantai',
      idempotencyKey: 'k2',
      correlationId: 'corr-crit',
      outbox: { mode: 'on_create', priority: 'critical' },
    });

    expect(await storage.outboxPending()).toBe(2);

    const publishedOrder: string[] = [];
    const criticalAlerts: CriticalAlertMessage[] = [];
    let brokerDown = true;

    const publisher: EventPublisher = {
      publish: vi.fn(async (ev) => {
        if (brokerDown) throw new Error('broker connection lost');
        publishedOrder.push(ev.hazard_id);
      }),
      publishCriticalAlert: vi.fn(async (alert) => {
        if (brokerDown) throw new Error('broker connection lost');
        criticalAlerts.push(alert);
      }),
    };

    const dispatcher = new OutboxDispatcher(storage, publisher, logger, 500, 1000);

    // 1st flush while broker is down -> nothing marked published
    await dispatcher.flush();
    expect(await storage.outboxPending()).toBe(2);

    // Advance fake storage clock past leaseMs (1000ms) and bring broker back up
    storage.tick(1500);
    brokerDown = false;

    await dispatcher.flush();
    expect(await storage.outboxPending()).toBe(0);

    // Critical event MUST be dispatched before normal event
    expect(publishedOrder).toEqual([criticalEvent.hazard_id, normalEvent.hazard_id]);
    expect(criticalAlerts).toHaveLength(1);
    expect(criticalAlerts[0].hazard_id).toBe(criticalEvent.hazard_id);
  });
});
