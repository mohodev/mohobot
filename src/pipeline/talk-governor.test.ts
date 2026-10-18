import { describe, expect, it } from 'vitest';
import { TalkGovernor } from './talk-governor.js';

const message = (overrides: Partial<{ dm: boolean; mention: boolean }> = {}) => ({
  id: 'm', botId: 'b', platform: 'discord' as const, content: 'hello',
  author: { id: 'u', username: 'u', displayName: 'u', bot: false, isBotManager: false },
  channel: { id: 'c', dm: overrides.dm ?? false },
  mentionsBot: overrides.mention ?? false,
  attachments: [], createdAt: 1,
});
const social = (reason: 'natural group participation' | 'group question' | 'peer rp character interjected' | 'direct') => ({ action: 'reply' as const, urgency: 'low' as const, reason });

describe('TalkGovernor', () => {
  it('is a no-op when disabled and never blocks direct summons', () => {
    const governor = new TalkGovernor({ enabled: false, hourlyBudget: 0, cooldownMs: 1, consecutiveLimit: 0, maxBackoffMs: 1, backoffFactor: 2, governRoomQuestions: false, governPeerBanter: false });
    expect(governor.decide(message(), social('natural group participation')).allowed).toBe(true);
    const enabled = new TalkGovernor({ enabled: true, hourlyBudget: 0, cooldownMs: 1, consecutiveLimit: 0, maxBackoffMs: 1, backoffFactor: 2, governRoomQuestions: false, governPeerBanter: false });
    expect(enabled.decide(message({ dm: true }), social('direct')).reason).toBe('direct');
    expect(enabled.decide(message({ mention: true }), social('direct')).reason).toBe('direct');
  });

  it('governs only opted-in voluntary participation by default', () => {
    const governor = new TalkGovernor({ enabled: true, hourlyBudget: 1, cooldownMs: 100, consecutiveLimit: 2, maxBackoffMs: 1000, backoffFactor: 2, governRoomQuestions: false, governPeerBanter: false }, () => 1000);
    expect(governor.decide(message(), social('group question')).reason).toBe('outside-scope');
    expect(governor.decide(message(), social('peer rp character interjected')).reason).toBe('outside-scope');
    expect(governor.decide(message(), social('natural group participation')).reason).toBe('allowed');
    governor.commit('c');
    expect(governor.decide(message(), social('natural group participation')).reason).toBe('hourly-budget');
  });

  it('shares budget per channel and resets independently', () => {
    let now = 1000;
    const governor = new TalkGovernor({ enabled: true, hourlyBudget: 2, cooldownMs: 0, consecutiveLimit: 20, maxBackoffMs: 0, backoffFactor: 2, governRoomQuestions: true, governPeerBanter: true }, () => now);
    governor.commit('c');
    governor.commit('c');
    expect(governor.decide(message(), social('natural group participation')).reason).toBe('hourly-budget');
    expect(governor.decide({ ...message(), channel: { id: 'other', dm: false } }, social('natural group participation')).allowed).toBe(true);
    now += 3_600_001;
    expect(governor.decide(message(), social('natural group participation')).allowed).toBe(true);
  });
});
