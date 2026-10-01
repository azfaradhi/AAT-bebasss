import type { HazardEventMessage } from '../../../../shared-types/src/envelopes';
import { contextStorage } from './context';
import type { SeenSet } from './dedup';
import type { Logger } from './logger';
import type { SideEffect } from './sideEffect';

// What the AMQP layer should do with the delivery.
export type Outcome = 'ack' | 'requeue' | 'drop';

export interface HandlerDeps {
  seen: SeenSet;
  sideEffect: SideEffect;
  logger: Logger;
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

// Dedup on hazard_id before any side effect; redelivery is expected (at-least-once).
// ack = done or duplicate, requeue = side effect failed, drop = unparseable message
export async function processMessage(content: Buffer, deps: HandlerDeps): Promise<Outcome> {
  const message = parseEnvelope(content);
  if (!message) {
    deps.logger.error({}, 'dropping malformed message');
    return 'drop';
  }

  // Bind the producer's correlation_id for every log line of this message.
  return contextStorage.run({ correlationId: message.correlation_id }, async () => {
    const { hazard_id } = message.payload;
    const started = Date.now();

    if (deps.seen.has(hazard_id)) {
      deps.logger.info({ message_id: message.message_id, hazard_id }, 'duplicate hazard event skipped');
      return 'ack';
    }
    try {
      await deps.sideEffect(message.payload);
    } catch (err) {
      deps.logger.error({ message_id: message.message_id, hazard_id, err: err instanceof Error ? err.message : String(err) }, 'side effect failed, requeueing');
      return 'requeue';
    }
    deps.seen.add(hazard_id);
    deps.logger.info({ message_id: message.message_id, hazard_id, latency_ms: Date.now() - started }, 'hazard event processed');
    return 'ack';
  });
}
