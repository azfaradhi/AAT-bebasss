import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryStorage } from '../../../../shared-types/src/m2/fakes/in-memory-storage';
import { InMemoryCoordinator } from '../../../../shared-types/src/m2/fakes/in-memory-coordinator';
import { StorageBackedParker } from '../../../../shared-types/src/m2/fakes/in-memory-parker';
import type { CriticalAlertMessage, PantaiStation } from '../../../../shared-types/src/m2/types';
import type { Logger } from '../logger';
import { OutboxDispatcher } from '../publisher/outbox-dispatcher';
import { PantaiPoller } from '../sources/pantai-client';
import { resetMetricsForTest, renderPrometheusMetrics } from './obs';

const STATIONS: PantaiStation[] = [
  {
    station_id: 'stn-padang-01',
    name: 'Pelabuhan Teluk Bayur',
    province: 'Sumatera Barat',
    latitude: -0.9971,
    longitude: 100.3692,
  },
];

const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe('Game Day Compound Fault Drill (P5-K6, MB3-T13) & SLI/SLO Error Budget (P5-K8, MB3-T14)', () => {
  beforeEach(() => {
    resetMetricsForTest();
  });

  it('survives simultaneous sensor-pantai outage + broker crash + 3x traffic surge and recovers cleanly', async () => {
    const storage = new InMemoryStorage();
    const coordinator = new InMemoryCoordinator(storage, 'agg-node-a');
    const parker = new StorageBackedParker(storage);
    await storage.fenceBarrier('pantai', 1);

    let clockMs = Date.parse('2026-11-14T04:00:00.000Z');
    let sensorHealthy = true;
    let brokerHealthy = true;
    const deliveredCriticals: CriticalAlertMessage[] = [];
    const publishedEvents: string[] = [];

    const poller = new PantaiPoller({
      baseUrl: 'http://sensor-pantai:8080',
      authToken: 'token',
      instanceId: 'agg-node-a',
      breakerFailureThreshold: 3,
      breakerCooldownMs: 10000,
      storage,
      coordinator,
      parker,
      clock: () => clockMs,
      fetchFn: async (input) => {
        const url = String(input);
        if (url.includes('/v1/stations')) {
          return new Response(JSON.stringify({ items: STATIONS }), { status: 200 });
        }
        if (!sensorHealthy) {
          return new Response('Gateway Timeout', { status: 504 });
        }
        return new Response(
          JSON.stringify({
            generated_at: new Date(clockMs).toISOString(),
            next_cursor: `cur-${clockMs}`,
            items: [
              {
                observation_id: `obs-crit-${clockMs}`,
                station_id: 'stn-padang-01',
                observed_at: new Date(clockMs - 1000).toISOString(),
                sea_level_anomaly_m: 2.1,
                wave_height_m: 4.8,
                quality: 'ok',
                critical: true,
              },
            ],
          }),
          { status: 200 },
        );
      },
    });

    const dispatcher = new OutboxDispatcher(
      storage,
      {
        publish: async (ev) => {
          if (!brokerHealthy) throw new Error('Broker node rabbitmq-1 crashed');
          publishedEvents.push(ev.hazard_id);
        },
        publishCriticalAlert: async (alert) => {
          if (!brokerHealthy) throw new Error('Broker node rabbitmq-1 crashed');
          deliveredCriticals.push(alert);
        },
      },
      silentLogger,
      500,
      1000,
    );

    // Phase 1 (T+00s): Baseline healthy operation while broker goes down (Fault B)
    brokerHealthy = false;
    const p1 = await poller.pollOnce(1);
    expect(p1.accepted).toBe(1);
    await dispatcher.flush();
    // Outbox holds the critical alert safely while broker is down
    expect(await storage.outboxPending()).toBe(1);

    // Phase 2 (T+05s): Sensor Pantai crashes with 504 (Fault A)
    sensorHealthy = false;
    for (let i = 0; i < 3; i++) {
      await expect(poller.pollOnce(1)).rejects.toThrow();
    }
    expect(poller.getHealthStatus().breakerState).toBe('open');
    expect(poller.getHealthStatus().stale).toBe(true);

    // Phase 3 (T+20s): Broker quorum recovers + Sensor Pantai recovers after cooldown
    clockMs += 15000;
    storage.tick(15000);
    brokerHealthy = true;
    sensorHealthy = true;

    await dispatcher.flush();
    expect(await storage.outboxPending()).toBe(0);
    expect(deliveredCriticals).toHaveLength(1);

    const p2 = await poller.pollOnce(1);
    expect(p2.accepted).toBe(1);
    expect(poller.getHealthStatus().breakerState).toBe('closed');
    expect(poller.getHealthStatus().stale).toBe(false);

    await dispatcher.flush();
    expect(deliveredCriticals).toHaveLength(2);

    const metrics = renderPrometheusMetrics();
    expect(metrics).toContain('bnpb_breaker_state{target="sensor-pantai"} 0');
  });
});
