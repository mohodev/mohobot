import { describe, expect, it } from 'vitest';
import { decideSocially } from './social-decision.js';
import type { MohoMessage } from '../core/types.js';
const msg = (content: string, opts: Partial<MohoMessage> = {}): MohoMessage => ({ id: '1', platform: 'discord', botId: 'b', channel: { id: 'c', dm: false }, author: { id: 'u', username: 'u', bot: false }, content, mentionsBot: false, attachments: [], createdAt: 0, ...opts });
describe('social decision', () => {
  it('replies directly to DM and mentions', () => { expect(decideSocially(msg('hi', { mentionsBot: true })).action).toBe('reply'); expect(decideSocially(msg('hi', { channel: { id: 'c', dm: true } })).action).toBe('reply'); });
  it('skips low-information echoes after recent replies', () => { expect(decideSocially(msg('哈哈'), { recentReplies: 0, energy: .7, stress: .1 }).action).toBe('ignore'); expect(decideSocially(msg('普通陈述'), { recentReplies: 2, energy: .7, stress: .1 }).action).toBe('ignore'); });
  it('replies to a direct mention even when the simulated device is delaying notifications', () => { expect(decideSocially(msg('在吗', { mentionsBot: true }), { recentReplies: 0, energy: .7, stress: .1, deviceDelay: true }).action).toBe('reply'); });
  it('skips when simulated character is unavailable', () => { expect(decideSocially(msg('普通陈述'), { recentReplies: 0, energy: .05, stress: .1 }).action).toBe('ignore'); });
});
