import { buildDashboard } from './server';

async function main(): Promise<void> {
  const port = Number(process.env.ANALYTICS_DASHBOARD_PORT ?? 8110);
  const app = buildDashboard({
    aggregatorBaseUrl: process.env.AGGREGATOR_BASE_URL ?? 'http://aggregator:8090',
    internalKey: process.env.INTERNAL_SERVICE_KEY ?? (() => { throw new Error('INTERNAL_SERVICE_KEY is required'); })(),
  });
  const stop = async (): Promise<void> => { await app.close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  await app.listen({ port, host: '0.0.0.0' });
}

main().catch((e) => { process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
