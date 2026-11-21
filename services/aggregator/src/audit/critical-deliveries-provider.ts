import type { AuditProviders } from '../../../../shared-types/src/m2/types';

// Serves /internal/audit/critical-deliveries from the notifier's own delivery records (it records every critical alert it delivers, with end-to-end latency).
export function notifierDeliveriesProvider(baseUrl: string, timeoutMs = 3000, fetchImpl: typeof fetch = fetch): NonNullable<AuditProviders['criticalDeliveries']> {
  return async (q) => {
    const url = new URL('/internal/critical-deliveries', baseUrl);
    url.searchParams.set('limit', String(q.limit));
    if (q.cursor) url.searchParams.set('cursor', q.cursor);
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`notifier answered HTTP ${res.status}`);
    return (await res.json()) as Awaited<ReturnType<NonNullable<AuditProviders['criticalDeliveries']>>>;
  };
}
