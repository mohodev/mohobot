import { describe, expect, it } from 'vitest';

import type { MohoMessage } from '../../src/core/types.js';
import plugin, { scopeKey, welcomeText } from './index.js';

function message(opts: { userId?: string; bot?: boolean; dm?: boolean; guildId?: string; channel?: string } = {}): MohoMessage {
  return {
    id: 'm1',
    platform: 'discord',
    botId: 'main',
    channel: { id: opts.channel ?? 'c1', dm: opts.dm ?? false, guildId: opts.guildId },
    author: { id: opts.userId ?? 'u1', username: '小林', bot: opts.bot ?? false },
    content: '大家好',
    mentionsBot: false,
    attachments: [],
    createdAt: 1,
  };
}

function context(botName = '洛天依') {
  const store = new Map<string, unknown>();
  return {
    store,
    botConfig: { name: botName },
    storage: {
      async get<T>(key: string) { return store.get(key) as T | undefined; },
      async save<T>(key: string, value: T) { store.set(key, value); },
      async delete(key: string) { store.delete(key); },
      async query() { return []; },
    },
    logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } },
  } as never;
}

describe('scopeKey', () => {
  it('scopes by guild when known, else by channel', () => {
    expect(scopeKey(message({ guildId: 'g1' }))).toBe('seen:g1:u1');
    expect(scopeKey(message({}))).toBe('seen:channel:c1:u1');
    expect(scopeKey(message({ dm: true, channel: 'dm9' }))).toBe('seen:channel:dm9:u1');
  });
});

describe('welcomeText', () => {
  it('mentions DM openness in DMs and @-rules in guilds', () => {
    expect(welcomeText('洛天依', '小林', true)).toContain('私聊');
    expect(welcomeText('洛天依', '小林', false)).toContain('@');
  });
});

describe('welcome plugin onMessage', () => {
  it('greets once per scope and never stops the pipeline', async () => {
    const ctx = context();
    const first = await plugin.onMessage!(message({ guildId: 'g1' }), ctx);
    expect(first).toMatchObject({ reply: expect.stringContaining('欢迎') });
    expect(first).not.toHaveProperty('stop');
    // Same user, same guild: silent afterwards.
    expect(await plugin.onMessage!(message({ guildId: 'g1' }), ctx)).toBeUndefined();
    // Same user, another guild: greeted again.
    const other = await plugin.onMessage!(message({ guildId: 'g2' }), ctx);
    expect(other).toMatchObject({ reply: expect.stringContaining('欢迎') });
  });

  it('ignores bots', async () => {
    const ctx = context();
    expect(await plugin.onMessage!(message({ bot: true }), ctx)).toBeUndefined();
  });
});
