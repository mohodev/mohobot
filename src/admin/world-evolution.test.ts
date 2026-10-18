import { describe, expect, it } from 'vitest';
import { evolveWorld, evolutionRuleFor } from './world-evolution.js';
import type { WorldState } from './world.js';
import type { ScheduledWorldEvent } from './world-events.js';

function baseState(overrides?: Partial<WorldState>): WorldState {
  return {
    clock: '2026-10-18T12:00:00.000Z',
    weather: 'clear',
    location: 'online',
    activity: 'idle',
    mood: { energy: 0.65, sociability: 0.55, curiosity: 0.7, stress: 0.2 },
    events: [],
    schedule: [],
    appliedPhases: [],
    ...overrides,
  };
}

function concertEvent(overrides?: Partial<ScheduledWorldEvent>): ScheduledWorldEvent {
  return {
    id: 'evt-concert-1',
    kind: 'concert',
    title: 'Live show',
    startsAt: '2026-10-18T10:00:00.000Z',
    endsAt: '2026-10-18T16:00:00.000Z',
    location: 'Shanghai',
    timezone: 'Asia/Shanghai',
    trust: 'confirmed',
    ...overrides,
  };
}

describe('world evolution', () => {
  it('applies concert start phase and updates mood', () => {
    const state = baseState();
    const { state: next, result } = evolveWorld(state, concertEvent(), 'start');
    expect(result.applied).toBe(true);
    expect(result.phaseKey).toBe('evt-concert-1:start');
    expect(next.mood.energy!).toBeLessThan(state.mood.energy!);
    expect(next.mood.stress!).toBeGreaterThan(state.mood.stress!);
    expect(next.location).toBe('Shanghai');
    expect(next.appliedPhases).toContain('evt-concert-1:start');
  });

  it('is idempotent — same phase key is not applied twice', () => {
    const state = baseState({ appliedPhases: ['evt-concert-1:start'] });
    const { state: next, result } = evolveWorld(state, concertEvent(), 'start');
    expect(result.applied).toBe(false);
    expect(next).toBe(state);
    expect(next.mood).toEqual(state.mood);
  });

  it('applies rest phase and recovers energy', () => {
    const state = baseState({ mood: { energy: 0.3, sociability: 0.55, curiosity: 0.7, stress: 0.6 } });
    const event: ScheduledWorldEvent = {
      id: 'evt-rest-1', kind: 'rest', title: 'Rest day', startsAt: '2026-10-18T10:00:00.000Z',
      endsAt: '2026-10-18T22:00:00.000Z', location: '住处', timezone: 'Asia/Shanghai', trust: 'confirmed',
    };
    const { state: next, result } = evolveWorld(state, event, 'middle');
    expect(result.applied).toBe(true);
    expect(next.mood.energy).toBeGreaterThan(0.3);
    expect(next.mood.stress).toBeLessThan(0.6);
  });

  it('applies trip phase with location displacement', () => {
    const state = baseState();
    const event: ScheduledWorldEvent = {
      id: 'evt-trip-1', kind: 'trip', title: 'Visit Tokyo', startsAt: '2026-10-20T08:00:00.000Z',
      endsAt: '2026-10-22T20:00:00.000Z', location: 'Tokyo', timezone: 'Asia/Tokyo', trust: 'confirmed',
    };
    const { state: next } = evolveWorld(state, event, 'start');
    expect(next.location).toBe('Tokyo');
    expect(next.mood.curiosity!).toBeGreaterThan(state.mood.curiosity!);
  });

  it('clamps mood values to [0, 1]', () => {
    const state = baseState({ mood: { energy: 0.02, sociability: 0.55, curiosity: 0.7, stress: 0.98 } });
    const { state: next } = evolveWorld(state, concertEvent(), 'start');
    expect(next.mood.energy).toBeGreaterThanOrEqual(0);
    expect(next.mood.stress).toBeLessThanOrEqual(1);
  });

  it('evolutionRuleFor returns fallback for unknown phases', () => {
    const rule = evolutionRuleFor('news', 'end');
    expect(rule.mood).toBeDefined();
  });
});
