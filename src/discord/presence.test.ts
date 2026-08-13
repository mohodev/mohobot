import { describe, expect, it } from 'vitest';
import { presenceFromWorld } from './presence.js';

const world = (overrides: Partial<{ location: string; activity: string; energy: number; stress: number }> = {}) => ({
  clock: '', weather: '', location: overrides.location ?? 'online', activity: overrides.activity ?? '聊天中',
  mood: { energy: overrides.energy ?? .7, stress: overrides.stress ?? .2 }, events: [], schedule: [], appliedPhases: [],
});

describe('presenceFromWorld', () => {
  it('only publishes a coarse activity and state', () => {
    expect(presenceFromWorld(world({ location: 'offline' }))).toMatchObject({ status: 'invisible', afk: true });
    expect(presenceFromWorld(world({ stress: .9 }))).toMatchObject({ status: 'dnd' });
    expect(presenceFromWorld(world({ energy: .1 }))).toMatchObject({ status: 'idle', afk: true });
    expect(presenceFromWorld(world())).toEqual({ status: 'online', activity: '聊天中', afk: false });
  });
});
