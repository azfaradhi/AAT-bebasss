/**
 * CONFORMANCE SUITE — Coordinator (+ fencing interplay with StorageClient).
 * Drafted with LLM assistance (planning pass); reviewed and understood by the implementing member.
 */
import { describe, expect, it } from 'vitest';
import type { Coordinator, CursorState, StorageClient } from '../types';
import { FencedError } from '../types';
import { ctx, ev } from './storage.conformance';
import { nextIngestedAt } from '../ids';

export interface CoordHarness { coordinator: Coordinator; storage: StorageClient; failover(name: string): void }

const state = (position: unknown, last: string | null = null): CursorState => ({ position, last_ingested_at: last, updated_by: 'test' });
const until = async (cond: () => boolean, ms = 1000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 5)); } };

export function coordinatorConformance(name: string, make: () => CoordHarness): void {
  describe(`Coordinator conformance: ${name}`, () => {
    it('C1 runAsLeader enters fn with fence >= 1 and a live signal; isLeader true while running', async () => {
      const { coordinator } = make();
      let fence = 0; let aborted = true;
      const run = coordinator.runAsLeader('bmkg', async (c) => { fence = c.fence; aborted = c.signal.aborted; });
      await until(() => fence > 0);
      expect(fence).toBeGreaterThanOrEqual(1);
      expect(aborted).toBe(false);
      expect(coordinator.currentFence('bmkg')).toBe(fence);
      await coordinator.stop(); await run;
    });

    it('C2 failover aborts the old signal, re-enters fn with a STRICTLY higher fence', async () => {
      const h = make();
      const fences: number[] = []; const signals: AbortSignal[] = [];
      const run = h.coordinator.runAsLeader('satellite', async (c) => { fences.push(c.fence); signals.push(c.signal); await new Promise<void>((res) => c.signal.addEventListener('abort', () => res())); });
      await until(() => fences.length === 1);
      h.failover('satellite');
      await until(() => fences.length === 2);
      expect(signals[0].aborted).toBe(true);
      expect(fences[1]).toBeGreaterThan(fences[0]);
      await h.coordinator.stop(); await run;
    });

    it('C3 cursor CAS: stale version and stale fence are rejected; version advances on success', async () => {
      const h = make();
      let fence = 0;
      const run = h.coordinator.runAsLeader('pvmbg', async (c) => { fence = c.fence; });
      await until(() => fence > 0);
      const r0 = await h.coordinator.readCursor('pvmbg');
      expect(r0.state).toBeNull();
      expect(await h.coordinator.commitCursor('pvmbg', r0.version, state(100), fence)).toBe(true);
      expect(await h.coordinator.commitCursor('pvmbg', r0.version, state(101), fence)).toBe(false); // stale version
      const r1 = await h.coordinator.readCursor<number>('pvmbg');
      expect(r1.state?.position).toBe(100);
      expect(await h.coordinator.commitCursor('pvmbg', r1.version, state(102), fence - 1)).toBe(false); // wrong fence
      await h.coordinator.stop(); await run;
    });

    it('C4 ZOMBIE LEADER: after failover the old leader\'s storage writes AND cursor commit are rejected', async () => {
      const h = make();
      const seen: number[] = [];
      const run = h.coordinator.runAsLeader('bmkg', async (c) => { seen.push(c.fence); await new Promise<void>((res) => c.signal.addEventListener('abort', () => res())); });
      await until(() => seen.length === 1);
      const oldFence = seen[0];
      const cur = await h.coordinator.readCursor('bmkg');
      h.failover('bmkg');
      await until(() => seen.length === 2);
      // the "frozen" old leader wakes up and tries to finish its work with its OLD token
      await expect(h.storage.upsertEvent(ev('BMKG', 'late'), ctx({ fenceName: 'bmkg', fence: oldFence }))).rejects.toBeInstanceOf(FencedError);
      expect(await h.coordinator.commitCursor('bmkg', cur.version, state(1), oldFence)).toBe(false);
      // the new leader can write
      await expect(h.storage.upsertEvent(ev('BMKG', 'ok'), ctx({ fenceName: 'bmkg', fence: seen[1] }))).resolves.toMatchObject({ applied: true });
      await h.coordinator.stop(); await run;
    });

    it('C5 write-then-commit-offset converges after a crash between the two steps (idempotent replay)', async () => {
      const h = make();
      let fence = 0;
      const run = h.coordinator.runAsLeader('pantai', async (c) => { fence = c.fence; });
      await until(() => fence > 0);
      const batch = ['o1', 'o2', 'o3'];
      // attempt 1: writes happen, crash before commitCursor
      for (const r of batch) await h.storage.upsertEvent(ev('SENSOR_PANTAI', r), ctx({ fenceName: 'pantai', fence }));
      // attempt 2 (after restart): replays the same batch, then commits
      for (const r of batch) await h.storage.upsertEvent(ev('SENSOR_PANTAI', r), ctx({ fenceName: 'pantai', fence }));
      const cur = await h.coordinator.readCursor('pantai');
      expect(await h.coordinator.commitCursor('pantai', cur.version, state('after-o3'), fence)).toBe(true);
      expect((await h.storage.listEvents({ limit: 10 })).items).toHaveLength(3); // no duplicates
      await h.coordinator.stop(); await run;
    });

    it('C6 nextIngestedAt never goes backwards across leaders / skewed clocks (C-TIME)', () => {
      const t0 = Date.parse('2026-11-12T10:00:00.000Z');
      const a = nextIngestedAt(t0, null);
      const behind = nextIngestedAt(t0 - 30_000, a); // clock shifted -30 s
      const same = nextIngestedAt(t0, behind);
      expect(behind > a).toBe(true);
      expect(same > behind).toBe(true);
    });
  });
}
