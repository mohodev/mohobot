import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AIConfigSchema, BotConfigSchema, MediaConfigSchema, MemoryConfigSchema, SessionConfigSchema } from '../config/schema.js';
import { EventBus } from '../core/event.js';
import { createNullLogger } from '../core/logger.js';
import type { ChatMessage, MohoMessage } from '../core/types.js';
import type { SessionManagerLike } from '../session/types.js';
import { MessagePipeline } from './pipeline.js';
import { looksLikeAutoReply, normalizeForRepeat, RepeatGuard } from './repeat-guard.js';
import { TopicBuffer } from './topic-buffer.js';

describe('auto-reply detection', () => {
  it('recognises announced auto-replies in several bracket styles', () => {
    for (const text of ['[自动回复] 我现在不在', '【自动回复】忙碌中', '（自动回复）稍后联系', '[Auto-Reply] away', '  [autoreply] x']) {
      expect(looksLikeAutoReply(text), text).toBe(true);
    }
  });

  it('does not flag ordinary text that merely mentions the phrase', () => {
    for (const text of ['你好', '什么是自动回复？', '我开了自动回复功能', '[公告] 自动回复']) {
      expect(looksLikeAutoReply(text), text).toBe(false);
    }
  });

  it('normalizes case and whitespace', () => {
    expect(normalizeForRepeat('  Hello   World \n')).toBe('hello world');
  });
});

describe('RepeatGuard', () => {
  function guard(over: Partial<ConstructorParameters<typeof RepeatGuard>[0]> = {}) {
    let now = 1_000_000;
    const g = new RepeatGuard({ maxRepeats: 3, windowMs: 300_000, now: () => now, ...over });
    return { g, tick: (ms: number) => { now += ms; } };
  }

  it('lets the first two identical messages through and mutes the third', () => {
    const { g } = guard();
    expect(g.inspect('u', '你好')).toBeUndefined();
    expect(g.inspect('u', '你好')).toBeUndefined();
    expect(g.inspect('u', '你好')).toBe('repeat');
    expect(g.inspect('u', '你好')).toBe('repeat'); // stays muted while the streak continues
  });

  it('resets as soon as the sender says something different', () => {
    const { g } = guard();
    g.inspect('u', 'a'); g.inspect('u', 'a');
    expect(g.inspect('u', 'b')).toBeUndefined();
    expect(g.inspect('u', 'a')).toBeUndefined();
    expect(g.inspect('u', 'a')).toBeUndefined();
    expect(g.inspect('u', 'a')).toBe('repeat');
  });

  it('forgets a streak once the window has passed', () => {
    const { g, tick } = guard();
    g.inspect('u', 'x'); g.inspect('u', 'x');
    tick(300_001);
    expect(g.inspect('u', 'x')).toBeUndefined();
    expect(g.inspect('u', 'x')).toBeUndefined();
    expect(g.inspect('u', 'x')).toBe('repeat');
  });

  it('keeps authors independent and ignores case/whitespace differences', () => {
    const { g } = guard();
    g.inspect('u1', 'Hi  there'); g.inspect('u1', 'hi there');
    expect(g.inspect('u2', 'hi there')).toBeUndefined();
    expect(g.inspect('u1', ' HI THERE ')).toBe('repeat');
  });

  it('flags auto-replies immediately and never counts blank text', () => {
    const { g } = guard();
    expect(g.inspect('u', '[自动回复] 忙')).toBe('auto_reply');
    for (let i = 0; i < 5; i += 1) expect(g.inspect('u', '   ')).toBeUndefined();
  });

  it('honours a custom threshold (minimum 2)', () => {
    const { g } = guard({ maxRepeats: 2 });
    expect(g.inspect('u', 'z')).toBeUndefined();
    expect(g.inspect('u', 'z')).toBe('repeat');
    const { g: clamped } = guard({ maxRepeats: 0 });
    clamped.inspect('u', 'z');
    expect(clamped.inspect('u', 'z')).toBe('repeat');
  });

  it('stays bounded under a flood of distinct authors', () => {
    const { g } = guard({ maxKeys: 50 });
    for (let i = 0; i < 500; i += 1) g.inspect(`user-${i}`, 'hello');
    expect(g.size()).toBeLessThanOrEqual(50);
    g.clear();
    expect(g.size()).toBe(0);
  });
});

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

async function pipelineHarness(repeatGuard?: Record<string, unknown>) {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mohobot-repeat-'));
  roots.push(stateRoot);
  const base = BotConfigSchema.parse({ id: 'main', rateLimit: { enabled: false }, ...(repeatGuard ? { repeatGuard } : {}) });
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
  let calls = 0;
  const pipeline = new MessagePipeline({
    config, stateRoot,
    topicBuffer: new TopicBuffer({ quietMs: 5 }),
    provider: { name: 'test', model: 'test', async chat() { calls += 1; return { content: 'ok。', model: 'test', ms: 0 }; }, async health() { return { ok: true }; } },
    sessions, events: new EventBus(), logger: createNullLogger(), send: async () => {},
  });
  let n = 0;
  const say = async (userId: string, content: string, manager = false): Promise<void> => {
    n += 1;
    const message: MohoMessage = {
      id: `r-${n}-${Math.random()}`, platform: 'discord', botId: 'main', channel: { id: 'dm', dm: true },
      author: { id: userId, username: 'u', bot: false, ...(manager ? { isBotManager: true } : {}) },
      content, mentionsBot: true, attachments: [], createdAt: n,
    };
    await pipeline.handle(message);
  };
  return { say, calls: () => calls };
}

describe('pipeline repeat guard', () => {
  it('answers the first two identical messages and ignores the rest', async () => {
    const h = await pipelineHarness();
    await h.say('u1', '在吗'); await h.say('u1', '在吗');
    expect(h.calls()).toBe(2);
    await h.say('u1', '在吗'); await h.say('u1', '在吗');
    expect(h.calls()).toBe(2);
    await h.say('u1', '换个话题');
    expect(h.calls()).toBe(3);
  });

  it('drops auto-replies without calling the model', async () => {
    const h = await pipelineHarness();
    await h.say('u1', '[自动回复] 我现在有事，稍后回复');
    expect(h.calls()).toBe(0);
  });

  it('exempts administrators and can be switched off', async () => {
    const admin = await pipelineHarness();
    for (let i = 0; i < 4; i += 1) await admin.say('boss', '重复', true);
    expect(admin.calls()).toBe(4);

    const off = await pipelineHarness({ enabled: false });
    for (let i = 0; i < 4; i += 1) await off.say('u1', '重复');
    await off.say('u1', '[自动回复] x');
    expect(off.calls()).toBe(5);
  });

  it('honours a per-bot threshold', async () => {
    const h = await pipelineHarness({ maxRepeats: 2 });
    await h.say('u1', 'x'); await h.say('u1', 'x');
    expect(h.calls()).toBe(1);
  });
});
