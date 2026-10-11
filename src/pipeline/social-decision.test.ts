import { describe, expect, it } from 'vitest';
import { decideSocially } from './social-decision.js';
import type { MohoMessage } from '../core/types.js';

const msg = (content: string, opts: Partial<MohoMessage> = {}): MohoMessage => ({
  id: '1', platform: 'discord', botId: 'b', channel: { id: 'c', dm: false },
  author: { id: 'u', username: 'u', bot: false }, content, mentionsBot: false,
  attachments: [], createdAt: 0, ...opts,
});

describe('social decision', () => {
  it('replies directly to DM and mentions', () => {
    expect(decideSocially(msg('hi', { mentionsBot: true })).action).toBe('reply');
    expect(decideSocially(msg('hi', { channel: { id: 'c', dm: true } })).action).toBe('reply');
  });

  it('engages a whitelisted peer RP bot but cools down after three straight rounds', () => {
    const interjection = msg('你个荷韵就知道装死', { author: { id: 'tianyi', username: '天依', bot: true } });
    expect(decideSocially(interjection, { recentReplies: 0, energy: .7, stress: .1 }).action).toBe('reply');
    expect(decideSocially(interjection, { recentReplies: 3, energy: .7, stress: .1 }).action).toBe('ignore');
  });

  it('observes unremarkable chatter by default instead of gambling on every line', () => {
    // The old behaviour rolled dice on any group message, which made the bot
    // interject at random. Now a plain statement stays observed.
    expect(decideSocially(msg('今天天气不错'), { recentReplies: 0, energy: .7, stress: .1 }).action).toBe('ignore');
    expect(decideSocially(msg('普通陈述'), { recentReplies: 0, energy: .7, stress: .1 }).action).toBe('ignore');
    expect(decideSocially(msg('我昨天去看了演唱会'), { recentReplies: 0, energy: .7, stress: .1 }).action).toBe('ignore');
  });

  it('joins in only when explicitly opted in, and deterministically so', () => {
    const chatty = msg('我昨天去看了演唱会');
    expect(decideSocially(chatty, { recentReplies: 0, energy: .7, stress: .1, proactiveParticipation: true, proactiveRoll: 0.99 }).action).toBe('ignore');
    expect(decideSocially(chatty, { recentReplies: 0, energy: .7, stress: .1, proactiveParticipation: true, proactiveRoll: 0.01 }).action).toBe('reply');
  });

  it('answers the room when someone asks a question', () => {
    expect(decideSocially(msg('这个功能怎么用？'), { recentReplies: 0, energy: .7, stress: .1 }).action).toBe('reply');
    expect(decideSocially(msg('谁知道这首歌叫什么'), { recentReplies: 0, energy: .7, stress: .1 }).action).toBe('reply');
    // Still worth answering after a few replies, but not after a long run.
    expect(decideSocially(msg('这个功能怎么用？'), { recentReplies: 4, energy: .7, stress: .1 }).action).toBe('reply');
    expect(decideSocially(msg('这个功能怎么用？'), { recentReplies: 6, energy: .7, stress: .1 }).action).toBe('ignore');
  });

  it('skips low-information echoes and backs off after recent replies', () => {
    expect(decideSocially(msg('哈哈'), { recentReplies: 0, energy: .7, stress: .1 }).action).toBe('ignore');
    expect(decideSocially(msg('确实'), { recentReplies: 0, energy: .7, stress: .1 }).action).toBe('ignore');
    expect(decideSocially(msg('普通陈述'), { recentReplies: 3, energy: .7, stress: .1 }).action).toBe('ignore');
  });

  it('replies to a direct mention even when the simulated device is delaying notifications', () => {
    expect(decideSocially(msg('在吗', { mentionsBot: true }), { recentReplies: 0, energy: .7, stress: .1, deviceDelay: true }).action).toBe('reply');
  });

  it('skips when simulated character is unavailable', () => {
    expect(decideSocially(msg('普通陈述'), { recentReplies: 0, energy: .05, stress: .1 }).action).toBe('ignore');
    expect(decideSocially(msg('这个怎么用'), { recentReplies: 0, energy: .7, stress: .95 }).action).toBe('ignore');
  });

  it('treats a peer-listed bot @ as a direct summon', () => {
    const summon = msg('在吗', { author: { id: 'qcfr', username: 'QCFR', bot: true }, mentionsBot: true });
    expect(decideSocially(summon, { recentReplies: 0, energy: .7, stress: .1, peerSummon: true }))
      .toMatchObject({ action: 'reply', reason: 'direct' });
    // Direct privilege ignores the peer-bot cooldown.
    expect(decideSocially(summon, { recentReplies: 5, energy: .7, stress: .1, peerSummon: true }).action).toBe('reply');
    // Without the flag the same @ stays ordinary peer banter.
    expect(decideSocially(summon, { recentReplies: 0, energy: .7, stress: .1 }))
      .toMatchObject({ action: 'reply', reason: 'peer rp character interjected' });
    expect(decideSocially(summon, { recentReplies: 3, energy: .7, stress: .1 }).action).toBe('ignore');
  });
});
