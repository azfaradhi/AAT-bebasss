import pino, { Logger } from 'pino';
import { currentCorrelationId } from './context';

export type { Logger };

// log shape: timestamp, service, correlation_id, level, message, latency_ms?
export function createLogger(service: string, level = 'info'): Logger {
  return pino({
    level,
    base: null,
    messageKey: 'message',
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    formatters: { level: (label) => ({ level: label }) },
    mixin: () => ({ service, correlation_id: currentCorrelationId() ?? 'none' }),
  });
}
