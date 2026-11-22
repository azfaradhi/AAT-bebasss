import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryStorage } from '../../../../shared-types/src/m2/fakes/in-memory-storage';
import { InMemoryCoordinator } from '../../../../shared-types/src/m2/fakes/in-memory-coordinator';
import { StorageBackedParker } from '../../../../shared-types/src/m2/fakes/in-memory-parker';
import type { CriticalAlertMessage, PantaiStation } from '../../../../shared-types/src/m2/types';
import { PantaiPoller, validatePantaiObservation } from './pantai-client';
import { resetMetricsForTest, renderPrometheusMetrics } from '../resilience/obs';

const STATIONS: PantaiStation[] = [
  {
    station_id: 'stn-padang-01',
    name: 'Pelabuhan Teluk Bayur',
    province: 'Sumatera Barat',
    latitude: -0.9971,
    longitude: 100.3692,
  },
];

describe('Sensor Pantai Poller, Behavior-Based Validation & Resilience (MB3-T08, P5-K1..K4)', () => {
  beforeEach(() => {
    resetMetricsForTest();
  });

  it('validates all 8 deviant behavior categories without hardcoded IDs (P5-K2)', () => {
    const stationsMap = new Map(STATIONS.map((s) => [s.station_id, s]));
    const seen = new Map<string, string>();
    const generatedAt = '2026-11-12T02:43:05Z';

    // 1. Valid normal observation
    const validRes = validatePantaiObservation(
      {
        observation_id: 'obs-000812',
        station_id: 'stn-padang-01',
        observed_at: '2026-11-12T02:43:00Z',
        sea_level_anomaly_m: 0.42,
        wave_height_m: 1.8,
        quality: 'ok',
        critical: false,
      },
      generatedAt,
      stationsMap,
      seen,
    );
    expect(validRes.status).toBe('valid');
    if (validRes.status === 'valid') {
      seen.set(validRes.observation.observation_id, validRes.fingerprint);
    }

    // 2. Identical duplicate -> status: 'duplicate'
    const dupRes = validatePantaiObservation(
      {
        observation_id: 'obs-000812',
        station_id: 'stn-padang-01',
        observed_at: '2026-11-12T02:43:00Z',
        sea_level_anomaly_m: 0.42,
        wave_height_m: 1.8,
        quality: 'ok',
        critical: false,
      },
      generatedAt,
      stationsMap,
      seen,
    );
    expect(dupRes.status).toBe('duplicate');

    // 3. Conflicting duplicate (same observation_id, different anomaly) -> status: 'violation'
    const conflictRes = validatePantaiObservation(
      {
        observation_id: 'obs-000812',
        station_id: 'stn-padang-01',
        observed_at: '2026-11-12T02:43:00Z',
        sea_level_anomaly_m: 2.5,
        wave_height_m: 1.8,
        quality: 'ok',
        critical: true,
      },
      generatedAt,
      stationsMap,
      seen,
    );
    expect(conflictRes.status).toBe('violation');

    // 4. Stale timestamp (silent freeze: observed_at 2h43m behind generated_at > 3600s)
    const staleRes = validatePantaiObservation(
      {
        observation_id: 'x1',
        station_id: 'stn-padang-01',
        observed_at: '2026-11-12T00:00:00Z',
        sea_level_anomaly_m: 0.1,
        wave_height_m: 1.0,
        quality: 'ok',
        critical: false,
      },
      generatedAt,
      stationsMap,
      seen,
    );
    expect(staleRes.status).toBe('violation');
    if (staleRes.status === 'violation') {
      expect(staleRes.detail).toContain('stale_observation');
    }

    // 5. Type violation (number as string)
    const typeRes = validatePantaiObservation(
      {
        observation_id: 'x2',
        station_id: 'stn-padang-01',
        observed_at: '2026-11-12T02:43:00Z',
        sea_level_anomaly_m: '0.4',
        wave_height_m: 1.0,
        quality: 'ok',
        critical: false,
      },
      generatedAt,
      stationsMap,
      seen,
    );
    expect(typeRes.status).toBe('violation');

    // 6. Missing required field
    const missingRes = validatePantaiObservation(
      {
        observation_id: 'x3',
        station_id: 'stn-padang-01',
        observed_at: '2026-11-12T02:43:00Z',
        wave_height_m: 1.0,
        quality: 'ok',
        critical: false,
      },
      generatedAt,
      stationsMap,
      seen,
    );
    expect(missingRes.status).toBe('violation');

    // 7. Physically impossible value
    const rangeRes = validatePantaiObservation(
      {
        observation_id: 'x4',
        station_id: 'stn-padang-01',
        observed_at: '2026-11-12T02:43:00Z',
        sea_level_anomaly_m: 9999,
        wave_height_m: -5,
        quality: 'ok',
        critical: false,
      },
      generatedAt,
      stationsMap,
      seen,
    );
    expect(rangeRes.status).toBe('violation');

    // 8. Non-ok quality flag & unknown station
    const qualRes = validatePantaiObservation(
      {
        observation_id: 'x5',
        station_id: 'stn-padang-01',
        observed_at: '2026-11-12T02:43:00Z',
        sea_level_anomaly_m: 0.2,
        wave_height_m: 1.1,
        quality: 'suspect',
        critical: false,
      },
      generatedAt,
      stationsMap,
      seen,
    );
    expect(qualRes.status).toBe('violation');
  });

  it('ingests valid coastal observations, quarantines deviant ones to Parker (CONTRACT_VIOLATION), and emits critical fast alerts (P5-K1, P5-K2)', async () => {
    const storage = new InMemoryStorage();
    const coordinator = new InMemoryCoordinator(storage, 'agg-pod-1');
    const parker = new StorageBackedParker(storage);
    const fastAlerts: CriticalAlertMessage[] = [];

    const fetchFn: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/v1/stations')) {
        return new Response(JSON.stringify({ items: STATIONS }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          generated_at: '2026-11-12T02:43:05Z',
          next_cursor: 'cur-2',
          items: [
            {
              observation_id: 'obs-valid-normal',
              station_id: 'stn-padang-01',
              observed_at: '2026-11-12T02:43:00Z',
              sea_level_anomaly_m: 0.3,
              wave_height_m: 1.5,
              quality: 'ok',
              critical: false,
            },
            {
              observation_id: 'obs-valid-critical',
              station_id: 'stn-padang-01',
              observed_at: '2026-11-12T02:43:02Z',
              sea_level_anomaly_m: 2.4,
              wave_height_m: 5.2,
              quality: 'ok',
              critical: true,
            },
            {
              observation_id: 'obs-bad-range',
              station_id: 'stn-padang-01',
              observed_at: '2026-11-12T02:43:01Z',
              sea_level_anomaly_m: 9999,
              wave_height_m: -5,
              quality: 'ok',
              critical: false,
            },
            {
              observation_id: 'obs-bad-stale',
              station_id: 'stn-padang-01',
              observed_at: '2026-11-12T00:00:00Z',
              sea_level_anomaly_m: 0.2,
              wave_height_m: 1.0,
              quality: 'ok',
              critical: false,
            },
          ],
        }),
        { status: 200 },
      );
    };

    const poller = new PantaiPoller({
      baseUrl: 'http://sensor-pantai:8080',
      authToken: 'test-token',
      instanceId: 'agg-pod-1',
      storage,
      coordinator,
      parker,
      criticalPublisher: {
        publishCriticalAlert: async (msg) => {
          fastAlerts.push(msg);
        },
      },
      fetchFn,
    });

    await storage.fenceBarrier('pantai', 1);
    const stats = await poller.pollOnce(1);
    expect(stats).toEqual({ accepted: 2, quarantined: 2, duplicates: 0 });

    // Verify canonical storage contains ONLY the 2 valid observations
    const stored = await storage.listEvents({ source: 'SENSOR_PANTAI', limit: 10 });
    expect(stored.items).toHaveLength(2);
    expect(stored.items.map((e) => e.source_ref_id).sort()).toEqual(['obs-valid-critical', 'obs-valid-normal']);
    const critEvent = stored.items.find((e) => e.source_ref_id === 'obs-valid-critical')!;
    expect(critEvent.severity).toBe('AWAS');
    expect(critEvent.hazard_type).toBe('COASTAL');

    // Verify fast critical alert was emitted immediately
    expect(fastAlerts).toHaveLength(1);
    expect(fastAlerts[0].hazard_id).toBe(critEvent.hazard_id);
    expect(fastAlerts[0].severity).toBe('AWAS');

    // Verify quarantined observations appear in Parker.listUnprocessed with reason_code=CONTRACT_VIOLATION
    const parked = await parker.listUnprocessed({ source: 'SENSOR_PANTAI', limit: 10 });
    expect(parked.items).toHaveLength(2);
    for (const p of parked.items) {
      expect(p.reason_code).toBe('CONTRACT_VIOLATION');
      expect(p.status).toBe('parked');
    }
  });

  it('trips CircuitBreaker when sensor-pantai fails and reports non-blocking stale status (P5-K4)', async () => {
    const storage = new InMemoryStorage();
    const coordinator = new InMemoryCoordinator(storage, 'agg-pod-1');
    const parker = new StorageBackedParker(storage);

    const poller = new PantaiPoller({
      baseUrl: 'http://sensor-pantai:8080',
      authToken: 'test-token',
      instanceId: 'agg-pod-1',
      breakerFailureThreshold: 2,
      breakerCooldownMs: 30000,
      storage,
      coordinator,
      parker,
      fetchFn: async () => new Response('Internal Server Error', { status: 500 }),
    });
    poller.setStationsForTest(STATIONS);

    await expect(poller.pollOnce(1)).rejects.toThrow();
    await expect(poller.pollOnce(1)).rejects.toThrow();

    const health = poller.getHealthStatus();
    expect(health.breakerState).toBe('open');
    expect(health.stale).toBe(true);
    expect(renderPrometheusMetrics()).toContain('bnpb_breaker_state{target="sensor-pantai"} 2');
  });
  it('marks SENSOR_PANTAI stale once on outage and fresh once on recovery, without a write per poll (P5-K4)', async () => {
    const storage = new InMemoryStorage();
    const coordinator = new InMemoryCoordinator(storage, 'agg-pod-1');
    const parker = new StorageBackedParker(storage);
    const calls: string[] = [];
    let down = true;
    const poller = new PantaiPoller({
      baseUrl: 'http://sensor-pantai:8080',
      authToken: 'test-token',
      instanceId: 'agg-pod-1',
      pollIntervalMs: 5,
      breakerFailureThreshold: 100,
      storage,
      coordinator,
      parker,
      syncState: {
        markSourceStale: async () => { calls.push('stale'); },
        markSourceFresh: async () => { calls.push('fresh'); },
      },
      fetchFn: async () => down
        ? new Response('boom', { status: 500 })
        : new Response(JSON.stringify({ generated_at: new Date().toISOString(), items: [], next_cursor: null }), { status: 200 }),
    });
    poller.setStationsForTest(STATIONS);
    void poller.start();
    await new Promise((r) => setTimeout(r, 150));
    down = false;
    await new Promise((r) => setTimeout(r, 150));
    poller.stop();
    expect(calls).toEqual(['stale', 'fresh']);
  });
});
