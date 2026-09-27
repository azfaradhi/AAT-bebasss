import { AsyncLocalStorage } from 'node:async_hooks';

export interface PollingContext {
  correlationId: string;
}

export const contextStorage = new AsyncLocalStorage<PollingContext>();

export function currentCorrelationId(): string | undefined {
  return contextStorage.getStore()?.correlationId;
}
