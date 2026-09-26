import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { HazardEventMessage } from '../../../../shared-types/src/envelopes';
import { currentCorrelationId } from './context';
import { SeenSet } from './dedup';
import { processMessage } from './handler';

const logger = pino({ level: 'silent' });

function envelope(hazardId: string, overrides: Partial<HazardEventMessage> = {}): Buffer {
  const message: HazardEventMessage = {
    message_id: 'm-1',
    event_type: 'HazardEventCreated',
    version: 1,
    published_at: '2026-09-26T10:00:00.000Z',
    correlation_id: 'corr-1',
    payload: {
      hazard_id: hazardId,
      source: 'BMKG',
      source_ref_id: 'e-1',
      hazard_type: 'SEISMIC',
      severity: 'AWAS',
      area_name: 'Somewhere',
      latitude: 0,
      longitude: 0,
      occurred_at: '2026-09-26T10:00:00.000Z',
      ingested_at: '2026-09-26T10:00:01.000Z',
      attributes: {},
    },
    ...overrides,
  };
  return Buffer.from(JSON.stringify(message));
}

function deps(sideEffect = vi.fn().mockResolvedValue(undefined)) {
  return { seen: new SeenSet(), sideEffect, logger };
}

describe('processMessage', () => {
  it('applies the side effect once and acks', async () => {
    const d = deps();
    expect(await processMessage(envelope('h-1'), d)).toBe('ack');
    expect(d.sideEffect).toHaveBeenCalledTimes(1);
    expect(d.sideEffect.mock.calls[0][0].hazard_id).toBe('h-1');
  });

  it('acks a redelivered hazard_id WITHOUT repeating the side effect', async () => {
    const d = deps();
    await processMessage(envelope('h-1'), d);
    expect(await processMessage(envelope('h-1', { message_id: 'm-2' }), d)).toBe('ack');
    expect(d.sideEffect).toHaveBeenCalledTimes(1);
  });

  it('processes distinct hazard_ids independently', async () => {
    const d = deps();
    await processMessage(envelope('h-1'), d);
    await processMessage(envelope('h-2'), d);
    expect(d.sideEffect).toHaveBeenCalledTimes(2);
  });

  it('requeues on side-effect failure and does not mark the id as seen', async () => {
    const sideEffect = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
    const d = deps(sideEffect);
    expect(await processMessage(envelope('h-1'), d)).toBe('requeue');
    expect(await processMessage(envelope('h-1'), d)).toBe('ack'); // the redelivery is retried, not skipped as a duplicate
    expect(sideEffect).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['not JSON', Buffer.from('nope')],
    ['wrong event_type', Buffer.from(JSON.stringify({ event_type: 'Other', version: 1 }))],
    ['missing hazard_id', Buffer.from(JSON.stringify({ event_type: 'HazardEventCreated', version: 1, correlation_id: 'c', payload: {} }))],
  ])('drops a malformed message (%s) without running the side effect', async (_name, content) => {
    const d = deps();
    expect(await processMessage(content, d)).toBe('drop');
    expect(d.sideEffect).not.toHaveBeenCalled();
  });

  it('binds the message correlation_id while processing', async () => {
    let seenId: string | undefined;
    const d = deps(vi.fn(async () => { seenId = currentCorrelationId(); }));
    await processMessage(envelope('h-1'), d);
    expect(seenId).toBe('corr-1');
  });
});
