import { buildUnitApp } from './app';
import { UnitEngine } from './engine';

const port = Number(process.env.STORAGE_UNIT_PORT ?? 8100);
const unit = process.env.STORAGE_UNIT_ID ?? process.env.NODE_NAME ?? process.env.POD_NAME ?? 'unit-local';
const node = process.env.NODE_NAME ?? unit;

const engine = new UnitEngine({ unit, node, dataDir: process.env.STORAGE_DATA_DIR });
const app = buildUnitApp(engine);

const shutdown = async (): Promise<void> => { await app.close(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

app.listen({ port, host: '0.0.0.0' }).then(() => process.stdout.write(`storage-unit ${unit} (${engine.state}) on ${port}\n`));
