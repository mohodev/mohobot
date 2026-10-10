import { describe, expect, it, vi } from 'vitest';

import type { MohoMessage } from '../../src/core/types.js';
import plugin, { DIVINATION_FIELDS, divinationFor, isDivinationTrigger, six66Reply } from './index.js';

function message(content: string, opts: { dm?: boolean; bot?: boolean; userId?: string } = {}): MohoMessage {
  return {
    id: 'm1',
    platform: 'discord',
    botId: 'main',
    channel: { id: 'c1', dm: opts.dm ?? false },
    author: { id: opts.userId ?? 'u1', username: 'user', bot: opts.bot ?? false },
    content,
    mentionsBot: false,
    attachments: [],
    createdAt: 1,
  };
}

function context(config: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>();
  return {
    storage: {
      async get<T>(key: string) { return store.get(key) as T | undefined; },
      async save<T>(key: string, value: T) { store.set(key, value); },
      async delete(key: string) { store.delete(key); },
      async query() { return []; },
    },
    config,
  } as never;
}

describe('divination triggers', () => {
  it('matches /占卜, bare 占卜 and 今日占卜', () => {
    expect(isDivinationTrigger('/占卜')).toBe(true);
    expect(isDivinationTrigger('占卜')).toBe(true);
    expect(isDivinationTrigger('今日占卜')).toBe(true);
    expect(isDivinationTrigger('/占卜 事业')).toBe(true);
  });

  it('ignores prose that merely mentions divination', () => {
    expect(isDivinationTrigger('我在研究占卜理论')).toBe(false);
    expect(isDivinationTrigger('占卜一下')).toBe(false);
    expect(isDivinationTrigger('')).toBe(false);
  });
});

describe('divinationFor', () => {
  it('is deterministic per user per day and covers every field', () => {
    const first = divinationFor('u1', 1_000_000);
    expect(divinationFor('u1', 1_000_000)).toBe(first);
    for (const field of DIVINATION_FIELDS) expect(first).toContain(field);
    expect(first).toMatch(/总评：(大吉|中吉|小吉|吉|末吉)/);
  });

  it('differs across users and across days', () => {
    const base = divinationFor('u1', 1_000_000);
    expect(divinationFor('u2', 1_000_000)).not.toBe(base);
    expect(divinationFor('u1', 1_000_000 + 86_400_000)).not.toBe(base);
  });
});

describe('six66Reply', () => {
  it('matches exact 6/66/666 only', () => {
    expect(six66Reply('6')).toContain('6=');
    expect(six66Reply('66')).toContain('66=');
    expect(six66Reply('666')).toContain('666=');
    expect(six66Reply('6666')).toBeUndefined();
    expect(six66Reply(' 66 ')).toContain('66=');
    expect(six66Reply('6好')).toBeUndefined();
  });
});

describe('fun plugin onMessage', () => {
  it('answers divination once per day and stops the pipeline', async () => {
    const ctx = context();
    const first = await plugin.onMessage!(message('占卜'), ctx);
    expect(first).toMatchObject({ stop: true });
    expect((first as { reply: string }).reply).toContain('今日占卜');
    const second = await plugin.onMessage!(message('占卜'), ctx);
    expect((second as { reply: string }).reply).toContain('明天再来');
  });

  it('fires the meme in guilds on a lucky roll and passes DMs through', async () => {
    const ctx = context({ probability: 100 });
    const hit = await plugin.onMessage!(message('666'), ctx);
    expect(hit).toMatchObject({ stop: true });
    const dm = await plugin.onMessage!(message('666', { dm: true }), ctx);
    expect(dm).toBeUndefined();
  });

  it('lets a lost roll continue to the AI', async () => {
    const ctx = context({ probability: 0 });
    expect(await plugin.onMessage!(message('66'), ctx)).toBeUndefined();
  });

  it('ignores bots and empty messages', async () => {
    const ctx = context();
    expect(await plugin.onMessage!(message('占卜', { bot: true }), ctx)).toBeUndefined();
    expect(await plugin.onMessage!(message('   '), ctx)).toBeUndefined();
    expect(await plugin.onMessage!(message('今天天气不错'), ctx)).toBeUndefined();
  });
});
