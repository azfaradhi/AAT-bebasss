import type { Coordinator } from '../../../shared-types/src/m2/types';
import type { FieldReportStore } from '../../../shared-types/src/field-reports';

export interface ProcessorStats { processed: number; cleaned: number; repaired: number; sweeps: number; errors: number }

export interface ProcessorDeps {
  coordinator: Coordinator;
  store: FieldReportStore;
  sweepIntervalMs: number;
  reconcileIntervalMs: number;
  stats: ProcessorStats;
  logger: { warn(obj: object, msg?: string): void };
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const onAbort = () => { clearTimeout(timer); resolve(); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
  signal.addEventListener('abort', onAbort, { once: true });
});

// Only the leader sweeps, so the fence token rejects a zombie. A failed sweep is retried on the next tick.
export function runFieldReportProcessor(deps: ProcessorDeps): Promise<void> {
  return deps.coordinator.runAsLeader('field-reports', async ({ fence, signal }) => {
    let lastReconcile = 0;
    while (!signal.aborted) {
      try {
        if (Date.now() - lastReconcile >= deps.reconcileIntervalMs) {
          deps.stats.repaired += await deps.store.reconcile(fence);
          lastReconcile = Date.now();
        }
        const { processed, cleaned } = await deps.store.sweep(fence);
        deps.stats.processed += processed;
        deps.stats.cleaned += cleaned;
        deps.stats.sweeps++;
        if (processed + cleaned > 0) continue; // more may be waiting
      } catch (err) {
        deps.stats.errors++;
        deps.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'field report sweep failed');
      }
      await sleep(deps.sweepIntervalMs, signal);
    }
  });
}
