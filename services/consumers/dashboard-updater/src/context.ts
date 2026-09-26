import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  correlationId: string;
}

export const contextStorage = new AsyncLocalStorage<RequestContext>();

export function currentCorrelationId(): string | undefined {
  return contextStorage.getStore()?.correlationId;
}
