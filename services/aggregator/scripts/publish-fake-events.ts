import { randomUUID } from 'node:crypto';
import pino from 'pino';
import type { HazardEvent, Severity } from '../../../shared-types/src/hazard-event';
import { RabbitMqEventPublisher } from '../src/publisher/eventPublisher';

const args = process.argv.slice(2);
const count = Number(args.find((a) => /^\d+$/.test(a)) ?? 3);
const duplicate = args.includes('--dup');
const severities: Severity[] = ['NORMAL', 'WASPADA', 'SIAGA', 'AWAS'];

function fakeEvent(i: number): HazardEvent {
  const seismic = i % 2 === 0;
  return {
    hazard_id: randomUUID(),
    source: seismic ? 'BMKG' : 'PVMBG',
    source_ref_id: `fake-${Date.now()}-${i}`,
    hazard_type: seismic ? 'SEISMIC' : 'VOLCANIC',
    severity: severities[i % severities.length],
    area_name: seismic ? `Fake Region ${i}` : 'Gunung Fake',
    latitude: -6 - i * 0.1,
    longitude: 106 + i * 0.1,
    occurred_at: new Date().toISOString(),
    ingested_at: new Date().toISOString(),
    attributes: seismic ? { magnitude: 5 + i * 0.3, depth_km: 10, potential_tsunami: false } : { eruption_count_24h: i, ash_column_height_m: 500 },
  };
}

async function main(): Promise<void> {
  const logger = pino({ level: 'info' });
  const publisher = new RabbitMqEventPublisher({ url: process.env.RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5672', logger });
  await publisher.start();
  const correlationId = randomUUID();
  for (let i = 0; i < count; i++) {
    const event = fakeEvent(i);
    await publisher.publish(event, correlationId);
    if (duplicate) await publisher.publish(event, correlationId);
  }
  await publisher.close();
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
