import { describe, expect, it } from 'vitest';
import { createWorldEvent } from './world-model.js';
import { replayWorld } from './world-replay.js';

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
});
