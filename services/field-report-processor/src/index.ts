import Fastify from 'fastify';
import pino from 'pino';
import { loggerOptions, registerHttpMetrics } from '../../../shared-types/src/obs-lite';
import { FieldReportStore } from '../../../shared-types/src/field-reports';
import { InMemoryCoordinator } from '../test-support/contract-fakes/fakes/in-memory-coordinator';
import { InMemoryStorage } from '../test-support/contract-fakes/fakes/in-memory-storage';
import { loadConfig } from './config';
import { runFieldReportProcessor, type ProcessorStats } from './processor';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = pino(loggerOptions('field-report-processor'));
  // Interim backends until Member 2's real StorageClient/Coordinator are wired; both sit behind the contract interfaces.
  const storage = new InMemoryStorage();
  const coordinator = new InMemoryCoordinator(storage, config.POD_NAME);
  const stats: ProcessorStats = { processed: 0, cleaned: 0, repaired: 0, sweeps: 0, errors: 0 };
  const store = new FieldReportStore(storage);

  let ready = false;
  const app = Fastify({ logger: false });
  const http = registerHttpMetrics(app, 'field-report-processor');
  app.get('/health', async () => ({ status: 'ok', service: 'field-report-processor', timestamp: new Date().toISOString() }));
  app.get('/ready', async (_req, reply) => (ready ? { status: 'ok' } : reply.code(503).send({ error: { code: 'NOT_READY', message: 'starting' } })));
  app.get('/metrics', async (_req, reply) => reply.header('content-type', 'text/plain; version=0.0.4').send([
    '# TYPE bnpb_field_reports_total counter',
    `bnpb_field_reports_total{outcome="processed"} ${stats.processed}`,
    `bnpb_field_reports_total{outcome="marker_cleaned"} ${stats.cleaned}`,
    `bnpb_field_reports_total{outcome="marker_repaired"} ${stats.repaired}`,
    `bnpb_field_reports_total{outcome="sweep_error"} ${stats.errors}`, '',
  ].join('\n') + http.render()));
  await app.listen({ port: config.FIELD_REPORT_PORT, host: '0.0.0.0' });

  const shutdown = async (): Promise<void> => {
    ready = false;
    await coordinator.stop();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  ready = true;
  await runFieldReportProcessor({ coordinator, store, sweepIntervalMs: config.SWEEP_INTERVAL_MS, reconcileIntervalMs: config.RECONCILE_INTERVAL_MS, stats, logger });
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
