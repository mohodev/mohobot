import { describe, expect, it } from 'vitest';
import { createWorldEvent } from './world-model.js';
import { replayWorld } from './world-replay.js';
import { WorldStore } from './world.js';
import { queryPersistentTraces } from './world-isolation.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

describe('world replay', () => {
  it('replays deterministically and deduplicates phase keys', () => {
    const event = createWorldEvent({ sourceKind: 'manual', sourceId: 'one', time: { start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' }, scope: 'world', payload: { n: 1 }, phase: 'day' });
    const records = [
      { event, action: 'confirm' as const },
      { event, action: 'activate' as const, phaseKey: 'day:2026-01-01' },
      { event, action: 'apply-phase' as const, phaseKey: 'day:2026-01-01' },
    ];
    const first = replayWorld(records);
    expect(replayWorld(records)).toEqual(first);
    expect(first.events).toHaveLength(1);
    expect(first.events[0]?.status).toBe('active');
    expect(first.phaseKeys).toEqual(['day:2026-01-01']);
  });

  it('replays schedule, confirmation, tick evolution and persisted trace end to end', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'world-replay-'));
    const start = '2032-03-01T10:00:00.000Z';
    const store = new WorldStore(root, 'replay-bot');
    try {
      await store.schedule({ id: 'replay-event', kind: 'rest', title: 'Quiet day', startsAt: start, endsAt: '2032-03-01T14:00:00.000Z', location: 'home' });
      await store.confirmScheduled('replay-event', 'confirmed');
      // +30 minutes into a 4h window keeps progress < 0.25, i.e. the 'start' phase.
      const evolved = await store.tick(Date.parse(start) + 30 * 60 * 1000);
      expect(evolved.schedule[0]?.trust).toBe('confirmed');
      expect(evolved.appliedPhases).toContain('replay-event:start');
      const traces = await queryPersistentTraces({ botId: 'replay-bot' });
      expect(traces.some((trace) => trace.kind === 'evolution')).toBe(true);
      const replayEvent = createWorldEvent({ sourceKind: 'manual', sourceId: 'replay-event', time: { start, end: '2032-03-01T14:00:00.000Z' }, scope: 'world', payload: { title: 'Quiet day' }, phase: 'start' });
      expect(replayWorld([{ event: replayEvent, action: 'confirm' }, { event: replayEvent, action: 'activate' }, { event: replayEvent, action: 'apply-phase', phaseKey: 'replay-event:start' }]).events[0]?.status).toBe('phase-applied');
    } finally {
      await store.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
