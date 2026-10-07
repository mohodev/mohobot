/**
 * Banned users must be ignored before any processing, administrators must be
 * able to manage bans from chat, and nobody else may.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AIConfigSchema, BotConfigSchema, MediaConfigSchema, MemoryConfigSchema, SessionConfigSchema } from '../config/schema.js';
import { EventBus } from '../core/event.js';
import { createNullLogger } from '../core/logger.js';
import type { ChatMessage, MohoMessage, OutboundMessage } from '../core/types.js';
import type { SessionManagerLike } from '../session/types.js';
import { BanStore } from './ban-store.js';
import { MessagePipeline } from './pipeline.js';
import { TopicBuffer } from './topic-buffer.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

const ADMIN = '900000000000000001';
const CONFIGURED_ADMIN = '900000000000000002';
let counter = 0;

async function harness(): Promise<{
  say: (userId: string, content: string, opts?: { manager?: boolean; channel?: string }) => Promise<void>;
  modelCalls: () => number;
  texts: () => string[];
  bans: BanStore;
}> {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mohobot-ban-'));
  roots.push(stateRoot);
  const base = BotConfigSchema.parse({ id: 'main', rateLimit: { enabled: false }, admin: { enabled: true, userIds: [CONFIGURED_ADMIN] } });
  const media = MediaConfigSchema.parse(base.media);
  const config = {
    ...base,
    ai: AIConfigSchema.parse({ ...base.ai, apiKey: 'test-key-123456', maxTokens: 0, stream: false }),
    session: SessionConfigSchema.parse({ ...base.session, persist: false }),
    memory: MemoryConfigSchema.parse(base.memory),
    media: { ...media, vision: { ...media.vision, apiKey: '' }, ocr: { ...media.ocr, apiKey: '' } },
  };
  const history: ChatMessage[] = [];
  const sessions: SessionManagerLike = {
    async get() { return { key: 'k', botId: 'main', channelId: 'c', userId: 'u', messages: history, updatedAt: 0 }; },
    async append(_key, message) { history.push(message); },
    async buildContext(_key, systemPrompt) { return [{ role: 'system', content: systemPrompt }, ...history]; },
    async clear() {}, async sweep() { return 0; }, size() { return 1; },
  };
  const outgoing: OutboundMessage[] = [];
  let calls = 0;
  const bans = BanStore.for(undefined, createNullLogger());
  const pipeline = new MessagePipeline({
    config, stateRoot, bans,
    topicBuffer: new TopicBuffer({ quietMs: 5 }),
    provider: { name: 'test', model: 'test', async chat() { calls += 1; return { content: '收到。', model: 'test', ms: 0 }; }, async health() { return { ok: true }; } },
    sessions, events: new EventBus(), logger: createNullLogger(), send: async (out) => { outgoing.push(out); },
  });
  return {
    async say(userId, content, opts = {}) {
      counter += 1;
      const message: MohoMessage = {
        id: `msg-${counter}`, platform: 'discord', botId: 'main', channel: { id: opts.channel ?? 'dm-1', dm: true },
        author: { id: userId, username: `user${userId.slice(-3)}`, bot: false, ...(opts.manager ? { isBotManager: true } : {}) },
        content, mentionsBot: true, attachments: [], createdAt: counter,
      };
      await pipeline.handle(message);
    },
    modelCalls: () => calls,
    texts: () => outgoing.map((o) => o.content),
    bans,
  };
}

describe('ban gate', () => {
  it('ignores a globally banned user silently, but serves everyone else', async () => {
    const h = await harness();
    await h.bans.ban({ userId: '111111', by: ADMIN });
    await h.say('111111', '你好');
    expect(h.modelCalls()).toBe(0);
    expect(h.texts()).toEqual([]);

    await h.say('222222', '你好');
    expect(h.modelCalls()).toBe(1);
    expect(h.texts().join('')).toContain('收到');
  });

  it('serves the user again once an expiring ban lapses', async () => {
    const h = await harness();
    await h.bans.ban({ userId: '111111', by: ADMIN, durationMs: 3_600_000 });
    await h.say('111111', 'hi');
    expect(h.modelCalls()).toBe(0);
    await h.bans.unban('111111');
    await h.say('111111', 'hi');
    expect(h.modelCalls()).toBe(1);
  });

  it('keeps a channel ban to its channel', async () => {
    const h = await harness();
    await h.bans.ban({ userId: '111111', channelId: 'chan-A', by: ADMIN });
    await h.say('111111', 'hi', { channel: 'chan-A' });
    expect(h.modelCalls()).toBe(0);
    await h.say('111111', 'hi', { channel: 'chan-B' });
    expect(h.modelCalls()).toBe(1);
  });

  it('never bans an administrator, even if a ban record exists', async () => {
    const h = await harness();
    await h.bans.ban({ userId: ADMIN, by: 'someone' });
    await h.say(ADMIN, '你好', { manager: true });
    expect(h.modelCalls()).toBe(1);
  });
});

describe('admin ban commands', () => {
  it('lets an admin ban, list and unban from chat', async () => {
    const h = await harness();
    await h.say(ADMIN, '?ban 333333 30m 刷屏', { manager: true });
    expect(h.texts().at(-1)).toContain('已封禁 333333');
    expect(h.texts().at(-1)).toContain('30m');
    expect(h.modelCalls()).toBe(0); // admin commands never reach the model

    await h.say('333333', '我回来了');
    expect(h.modelCalls()).toBe(0);

    await h.say(ADMIN, '?banlist', { manager: true });
    expect(h.texts().at(-1)).toContain('333333');
    expect(h.texts().at(-1)).toContain('刷屏');

    await h.say(ADMIN, '?unban 333333', { manager: true });
    expect(h.texts().at(-1)).toContain('已解除封禁');
    await h.say('333333', '我回来了');
    expect(h.modelCalls()).toBe(1);
  });

  it('accepts @mentions, permanent bans and --here scoping', async () => {
    const h = await harness();
    await h.say(ADMIN, '?ban <@!444444>', { manager: true });
    expect(h.texts().at(-1)).toContain('永久');
    expect(h.bans.check('444444', 'anything')).toBeDefined();

    await h.say(ADMIN, '?ban 555555 --here', { manager: true, channel: 'chan-X' });
    expect(h.bans.check('555555', 'chan-X')).toBeDefined();
    expect(h.bans.check('555555', 'chan-Y')).toBeUndefined();
    expect(h.texts().at(-1)).toContain('本频道');

    await h.say(ADMIN, '?unban 555555', { manager: true, channel: 'chan-X' }); // global unban must not remove a channel ban
    expect(h.texts().at(-1)).toContain('没有生效');
    await h.say(ADMIN, '?unban 555555 --here', { manager: true, channel: 'chan-X' });
    expect(h.bans.check('555555', 'chan-X')).toBeUndefined();
  });

  it('refuses to ban yourself or a configured administrator', async () => {
    const h = await harness();
    await h.say(ADMIN, `?ban ${ADMIN}`, { manager: true });
    expect(h.texts().at(-1)).toContain('不能封禁自己');
    await h.say(ADMIN, `?ban ${CONFIGURED_ADMIN} 1h`, { manager: true });
    expect(h.texts().at(-1)).toContain('不能封禁已配置的管理员');
    expect(h.bans.list()).toHaveLength(0);
  });

  it('reports bad input instead of throwing', async () => {
    const h = await harness();
    await h.say(ADMIN, '?ban', { manager: true });
    expect(h.texts().at(-1)).toContain('用法');
    await h.say(ADMIN, '?ban not/valid 1h', { manager: true });
    expect(h.texts().at(-1)).toContain('操作失败');
    await h.say(ADMIN, '?unban', { manager: true });
    expect(h.texts().at(-1)).toContain('用法');
    await h.say(ADMIN, '?banlist', { manager: true });
    expect(h.texts().at(-1)).toContain('没有生效');
  });

  it('stays completely silent for non-admins probing the commands', async () => {
    const h = await harness();
    await h.say('666666', '?ban 777777');
    await h.say('666666', '?banlist');
    expect(h.texts()).toEqual([]);
    expect(h.bans.list()).toHaveLength(0);
    expect(h.modelCalls()).toBe(0);
  });
});
