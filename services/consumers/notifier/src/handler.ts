import type { HazardEventMessage } from '../../../../shared-types/src/envelopes';
import type { CriticalAlertMessage, DeliveryRecord } from '../../../../shared-types/src/m2/types';
import { contextStorage } from './context';
import type { CriticalDeliveryStore } from './critical-delivery-store';
import type { SeenSet } from './dedup';
import type { Logger } from './logger';
import type { SideEffect } from './side-effect';
import { METRICS, amqpExtract, incCounter, observeHistogram } from './obs/index';

export type Outcome = 'ack' | 'requeue' | 'drop';

export interface HandlerDeps {
  seen: SeenSet;
  sideEffect: SideEffect;
  logger: Logger;
  criticalDeliveries?: CriticalDeliveryStore;
  clock?: () => number;
}

function parseEnvelope(content: Buffer): HazardEventMessage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(content.toString('utf8'));
  } catch {
    return null;
  }
  const m = raw as Partial<HazardEventMessage> | null;
  if (!m || m.event_type !== 'HazardEventCreated' || m.version !== 1) return null;
  if (typeof m.payload?.hazard_id !== 'string' || typeof m.correlation_id !== 'string') return null;
  return m as HazardEventMessage;
}

function parseCriticalAlert(content: Buffer): CriticalAlertMessage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(content.toString('utf8'));
  } catch {
    return null;
  }
  const m = raw as Partial<CriticalAlertMessage> | null;
  if (!m || typeof m !== 'object') return null;
  if (
    typeof m.message_id !== 'string' ||
    typeof m.hazard_id !== 'string' ||
    typeof m.source !== 'string' ||
    typeof m.severity !== 'string' ||
    typeof m.detected_at !== 'string' ||
    typeof m.correlation_id !== 'string'
  ) {
    return null;
  }
  return m as CriticalAlertMessage;
}

export async function processMessage(
  content: Buffer,
  deps: HandlerDeps,
  headers?: Record<string, unknown>,
): Promise<Outcome> {
  const message = parseEnvelope(content);
  if (!message) {
    deps.logger.error({}, 'dropping malformed message');
    return 'drop';
  }

  return amqpExtract(headers, () =>
    contextStorage.run({ correlationId: message.correlation_id }, async () => {
      const { hazard_id } = message.payload;
      const started = Date.now();

      if (deps.seen.has(hazard_id)) {
        deps.logger.info({ message_id: message.message_id, hazard_id }, 'duplicate hazard event skipped');
        return 'ack';
      }
      try {
        await deps.sideEffect(message.payload);
      } catch (err) {
        deps.logger.error(
          { message_id: message.message_id, hazard_id, err: err instanceof Error ? err.message : String(err) },
          'side effect failed, requeueing',
        );
        return 'requeue';
      }
      deps.seen.add(hazard_id);
      deps.logger.info(
        { message_id: message.message_id, hazard_id, latency_ms: Date.now() - started },
        'hazard event processed',
      );
      return 'ack';
    }),
  );
}

/**
 * Fast-path critical alert consumer handler for `critical_alerts_queue` (P5-K1, MB3-T10).
 */
export async function processCriticalAlert(
  content: Buffer,
  deps: HandlerDeps,
  headers?: Record<string, unknown>,
): Promise<Outcome> {
  const alert = parseCriticalAlert(content);
  if (!alert) {
    deps.logger.error({}, 'dropping malformed critical alert message');
    incCounter(METRICS.criticalTotal, { outcome: 'dropped_malformed' });
    return 'drop';
  }

  const clock = deps.clock ?? Date.now;
  return amqpExtract(headers, () =>
    contextStorage.run({ correlationId: alert.correlation_id }, async () => {
      if (deps.criticalDeliveries?.hasSeen(alert.message_id, alert.hazard_id)) {
        deps.logger.info(
          { message_id: alert.message_id, hazard_id: alert.hazard_id },
          'duplicate critical alert skipped',
        );
        incCounter(METRICS.criticalTotal, { outcome: 'dedup' });
        return 'ack';
      }

      try {
        await deps.sideEffect({
          hazard_id: alert.hazard_id,
          source: alert.source,
          source_ref_id: alert.message_id,
          hazard_type: alert.source === 'SENSOR_PANTAI' ? 'COASTAL' : 'SEISMIC',
          severity: alert.severity,
          area_name: alert.area_name,
          latitude: 0,
          longitude: 0,
          occurred_at: alert.occurred_at,
          ingested_at: alert.detected_at,
          attributes: { fast_path: true },
        });
      } catch (err) {
        deps.logger.error(
          { message_id: alert.message_id, hazard_id: alert.hazard_id, err: err instanceof Error ? err.message : String(err) },
          'critical alert delivery failed, requeueing',
        );
        incCounter(METRICS.criticalTotal, { outcome: 'requeued' });
        return 'requeue';
      }

      const nowMs = clock();
      const detectedMs = Date.parse(alert.detected_at);
      const e2eSeconds = Number.isFinite(detectedMs) ? Math.max(0, (nowMs - detectedMs) / 1000) : 0;

      const record: DeliveryRecord = {
        message_id: alert.message_id,
        hazard_id: alert.hazard_id,
        delivered_at: new Date(nowMs).toISOString(),
        e2e_seconds: Number(e2eSeconds.toFixed(4)),
      };

      deps.criticalDeliveries?.record(record);
      deps.seen.add(alert.hazard_id);
      observeHistogram(METRICS.criticalE2E, {}, e2eSeconds);
      incCounter(METRICS.criticalTotal, { outcome: 'delivered' });

      deps.logger.info(
        {
          message_id: alert.message_id,
          hazard_id: alert.hazard_id,
          e2e_seconds: record.e2e_seconds,
          latency_ms: Math.round(e2eSeconds * 1000),
        },
        'critical alert delivered to notifier-lapangan',
      );
      return 'ack';
    }),
  );
}
