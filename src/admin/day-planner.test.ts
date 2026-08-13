import { describe, expect, it } from 'vitest';
import { RuleDayPlanner } from './day-planner.js';

describe('RuleDayPlanner', () => {
  it('creates a bounded daily schedule and reacts to stress', async () => {
    const plan = await new RuleDayPlanner().plan({
      date: '2026-08-13', character: 'Moho',
      world: { clock: '', weather: 'rain', location: 'home', activity: 'idle', mood: { energy: .4, sociability: .5, curiosity: .7, stress: .9 }, events: [], schedule: [], appliedPhases: [] },
    });
    expect(plan.source).toBe('rules');
    expect(plan.items.length).toBeGreaterThan(3);
    expect(plan.items.some((item) => item.activity === '安静独处')).toBe(true);
  });
});
