/**
 * Admin text commands: Chinese alias resolution plus the usage and broadcast
 * bridges. Non-admin `?...` stays silent; `?ab` keeps its own owner-scoped
 * path and is not covered here.
 */

import { describe, expect, it } from 'vitest';

import { AIConfigSchema, BotConfigSchema, MediaConfigSchema, MemoryConfigSchema, SessionConfigSchema } from '../config/schema.js';
import { EventBus } from '../core/event.js';
import { createNullLogger } from '../core/logger.js';
import type { MohoMessage } from '../core/types.js';
import type { ChatMessage } from '../core/types.js';
import type { SessionManagerLike } from '../session/types.js';
import { AIError } from '../ai/types.js';
import { ADMIN_COMMAND_ALIASES, MessagePipeline, type BroadcastBridge, type UsageBridge } from './pipeline.js';
import { TopicBuffer } from './topic-buffer.js';

function build(overrides: { usage?: UsageBridge; broadcast?: BroadcastBridge; admin?: boolean; emotion?: import('./pipeline.js').EmotionBridge } = {}) {
  const base = BotConfigSchema.parse({ id: 'main', rateLimit: { enabled: false }, admin: { enabled: true, userIds: ['admin1'] } });
  const config = {
    ...base,
    ai: AIConfigSchema.parse({ ...base.ai, apiKey: 'test-key-123456', maxTokens: 0 }),
    session: SessionConfigSchema.parse({ ...base.session, persist: false }),
    memory: MemoryConfigSchema.parse(base.memory),
    media: (() => { const media = MediaConfigSchema.parse(base.media); return { ...media, vision: { ...media.vision, apiKey: '' }, ocr: { ...media.ocr, apiKey: '' } }; })(),
  };
  const sessions: SessionManagerLike = {
    async get() { return { key: 'k', botId: 'main', channelId: 'c', userId: 'u', messages: [], updatedAt: 0 }; },
    async append() {},
    async buildContext(_key, systemPrompt) { return [{ role: 'system', content: systemPrompt }]; },
    async clear() {}, async sweep() { return 0; }, size() { return 1; },
  };
  const outgoing: string[] = [];
  const pipeline = new MessagePipeline({
    config, sessions,
    usage: overrides.usage,
    broadcast: overrides.broadcast,
    emotion: overrides.emotion,
    topicBuffer: new TopicBuffer({ quietMs: 5 }),
    provider: {
      name: 'test', model: 'test',
      async chat() { throw new Error('model must not be called for admin commands'); },
      async health() { return { ok: true }; },
    },
    events: new EventBus(), logger: createNullLogger(), send: async (out) => { outgoing.push(out.content); },
  });
  return {
    outgoing,
    async run(content: string, admin = overrides.admin ?? true) {
      const message: MohoMessage = {
        id: `m-${outgoing.length}`, platform: 'discord', botId: 'main',
        channel: { id: 'c', dm: false },
        author: admin
          ? { id: 'admin1', username: 'admin', bot: false, isBotManager: true }
          : { id: 'u9', username: 'user', bot: false },
        content, mentionsBot: false, attachments: [], createdAt: 1,
      };
      await pipeline.handle(message);
    },
  };
}

describe('ADMIN_COMMAND_ALIASES', () => {
  it('maps every documented Chinese command to its handler key', () => {
    expect(ADMIN_COMMAND_ALIASES).toMatchObject({
      '好感度': 'favor',
      '关系阶段': 'stage',
      '好感排行': 'favor-rank',
      '设好感': 'set-favor',
      '设亲密': 'set-intimacy',
      '用量': 'usage',
      '广播': 'broadcast',
      '广播预告': 'broadcast',
      '广播确认': 'broadcast-confirm',
      '广播取消': 'broadcast-cancel',
    });
  });
});

describe('?好感度 (Chinese alias end-to-end)', () => {
  it('resolves the alias to the favor handler', async () => {
    const harness = build({
      emotion: {
        buildContextBlock: async () => '',
        scheduleTurn: () => {},
        getSnapshot: async (userKey: string) => ({
          userKey, favor: 12, intimacy: 8, stageName: '初识期', stageDescription: '好感驱动',
          compositeScore: 10, progressToNext: 40, nextStageName: '深化期', nextStageThreshold: 55,
          dominantMood: '喜悦', attitude: '友好', relationship: '朋友',
          interactions: { total: 5, positive: 4, negative: 1, positiveRatio: 80 },
          advice: '多聊聊',
        }),
        ranking: async () => [],
        setFavor: () => {},
        setIntimacy: () => {},
      },
    });
    await harness.run('?好感度');
    expect(harness.outgoing[0]).toContain('好感度：12');
    expect(harness.outgoing[0]).toContain('初识期');
  });
});

describe('repeat-guard trigger exemption', () => {
  it('never swallows deliberate trigger content, even repeated', async () => {
    // Inject a hook-only plugins facade: every 占卜 is answered, no AI needed.
    const hooked = buildWithPlugins();
    await hooked.run('占卜', false);
    await hooked.run('占卜', false);
    await hooked.run('占卜', false);
    expect(hooked.outgoing).toEqual(['🔮 test fortune', '🔮 test fortune', '🔮 test fortune']);
  });

  it('never swallows ? admin commands for non-managers either (silent, not noise)', async () => {
    // Non-admin ? text is intentionally silent (privilege probing), but it must
    // not consume the repeat budget as noise: covered by the startsWith guard.
    const hooked = buildWithPlugins();
    await hooked.run('?用量', false);
    await hooked.run('?用量', false);
    await hooked.run('?用量', false);
    // Silent (not admin), but also not model-answered: just no crash, no reply.
    expect(hooked.outgoing).toHaveLength(0);
  });

  function buildWithPlugins() {
    const base = BotConfigSchema.parse({ id: 'main', rateLimit: { enabled: false }, admin: { enabled: true, userIds: ['admin1'] } });
    const config = {
      ...base,
      ai: AIConfigSchema.parse({ ...base.ai, apiKey: 'test-key-123456', maxTokens: 0 }),
      session: SessionConfigSchema.parse({ ...base.session, persist: false }),
      memory: MemoryConfigSchema.parse(base.memory),
      media: (() => { const media = MediaConfigSchema.parse(base.media); return { ...media, vision: { ...media.vision, apiKey: '' }, ocr: { ...media.ocr, apiKey: '' } }; })(),
    };
    const sessions: SessionManagerLike = {
      async get() { return { key: 'k', botId: 'main', channelId: 'c', userId: 'u', messages: [], updatedAt: 0 }; },
      async append() {},
      async buildContext(_key, systemPrompt) { return [{ role: 'system', content: systemPrompt }]; },
      async clear() {}, async sweep() { return 0; }, size() { return 1; },
    };
    const outgoing: string[] = [];
    let seq = 0;
    const plugins = {
      async runMessageHooks(message: { content: string }) {
        if (message.content.trim() === '占卜') return { reply: '🔮 test fortune', stop: true };
        return {};
      },
      isTriggerContent(text: string) { return text.trim() === '占卜'; },
    };
    const pipeline = new MessagePipeline({
      config, sessions,
      plugins: plugins as never,
      topicBuffer: new TopicBuffer({ quietMs: 5 }),
      provider: {
        name: 'test', model: 'test',
        async chat() { throw new Error('model must not be called'); },
        async health() { return { ok: true }; },
      },
      events: new EventBus(), logger: createNullLogger(), send: async (out) => { outgoing.push(out.content); },
    });
    return {
      outgoing,
      async run(content: string, admin: boolean) {
        seq += 1;
        const message: MohoMessage = {
          id: `m-${seq}`, platform: 'discord', botId: 'main',
          channel: { id: 'c', dm: false },
          author: admin
            ? { id: 'admin1', username: 'admin', bot: false, isBotManager: true }
            : { id: 'u9', username: 'user', bot: false },
          content, mentionsBot: false, attachments: [], createdAt: seq,
        };
        await pipeline.handle(message);
      },
    };
  }
});

describe('model failure replies (user-facing)', () => {
  async function runWithFailure(kind: string) {
    const base = BotConfigSchema.parse({ id: 'main', rateLimit: { enabled: false } });
    const config = {
      ...base,
      ai: AIConfigSchema.parse({ ...base.ai, apiKey: 'test-key-123456', maxTokens: 0 }),
      session: SessionConfigSchema.parse({ ...base.session, persist: false }),
      memory: MemoryConfigSchema.parse(base.memory),
      media: (() => { const media = MediaConfigSchema.parse(base.media); return { ...media, vision: { ...media.vision, apiKey: '' }, ocr: { ...media.ocr, apiKey: '' } }; })(),
    };
    const sessions: SessionManagerLike = {
      async get() { return { key: 'k', botId: 'main', channelId: 'c', userId: 'u', messages: [], updatedAt: 0 }; },
      async append() {},
      async buildContext() { return [{ role: 'user', content: 'hi' }]; },
      async clear() {}, async sweep() { return 0; }, size() { return 1; },
    };
    const outgoing: string[] = [];
    const pipeline = new MessagePipeline({
      config, sessions,
      topicBuffer: new TopicBuffer({ quietMs: 5 }),
      provider: {
        name: 'test', model: 'test',
        async chat() { throw new AIError('boom', { kind: kind as never, retryable: true }); },
        async health() { return { ok: true }; },
      },
      events: new EventBus(), logger: createNullLogger(), send: async (out) => { outgoing.push(out.content); },
    });
    await pipeline.handle({
      id: 'm1', platform: 'discord', botId: 'main', channel: { id: 'c', dm: true },
      author: { id: 'u', username: 'user', bot: false }, content: 'hi', mentionsBot: true,
      attachments: [], createdAt: 1,
    });
    return outgoing;
  }

  it('answers timeouts, rate limits and outages in Chinese asides, never English dev-speak', async () => {
    expect(await runWithFailure('timeout')).toEqual(['（刚才那句想得太久超时了，再发一次试试？）']);
    expect(await runWithFailure('rate_limit')).toEqual(['（对面限流了，歇个几秒再找我吧）']);
    expect(await runWithFailure('auth')).toEqual(['（我的模型钥匙好像失效了，叫管理员看一眼配置吧）']);
    expect(await runWithFailure('server')).toEqual(['（AI 服务刚才没连上，过会儿再试一次吧）']);
    expect(await runWithFailure('network')).toEqual(['（AI 服务刚才没连上，过会儿再试一次吧）']);
  });

  it('falls back to the configured fallbackReply for unknown kinds', async () => {
    expect(await runWithFailure('unknown')).toEqual(['（刚才没连上，想说的话再发一次吧）']);
  });
});

describe('?用量', () => {
  it('reports through the bridge and parses the day window', async () => {
    const seen: number[] = [];
    const harness = build({ usage: { report: async (days: number) => { seen.push(days); return `report-${days}`; }, sessionReport: async (days: number) => `session-${days}` } });
    await harness.run('?用量');
    await harness.run('?用量 7');
    await harness.run('?用量 nonsense');
    expect(harness.outgoing).toEqual(['report-1', 'report-7', 'report-1']);
    expect(seen).toEqual([1, 7, 1]);
  });

  it('routes 会话 to the session report with its own day window', async () => {
    const seen: number[] = [];
    const harness = build({ usage: { report: async () => 'should-not-fire', sessionReport: async (days: number) => { seen.push(days); return `session-${days}`; } } });
    await harness.run('?用量 会话');
    await harness.run('?用量 会话 7');
    await harness.run('?用量 会话 nonsense');
    expect(harness.outgoing).toEqual(['session-1', 'session-7', 'session-1']);
    expect(seen).toEqual([1, 7, 1]);
  });

  it('degrades gracefully without a bridge', async () => {
    const harness = build({});
    await harness.run('?用量');
    await harness.run('?用量 会话');
    expect(harness.outgoing[0]).toContain('未启用');
  });

  it('stays silent for non-admins', async () => {
    const harness = build({ usage: { report: async () => 'never', sessionReport: async () => 'never' } }, );
    await harness.run('?用量', false);
    await harness.run('?用量 会话', false);
    expect(harness.outgoing).toHaveLength(0);
  });
});

describe('songs injection and ?同步歌曲', () => {
  function songsHarness(songs: import('./pipeline.js').SongBridge | undefined) {
    const base = BotConfigSchema.parse({ id: 'main', rateLimit: { enabled: false }, admin: { enabled: true, userIds: ['admin1'] } });
    const config = {
      ...base,
      ai: AIConfigSchema.parse({ ...base.ai, apiKey: 'test-key-123456', maxTokens: 0 }),
      session: SessionConfigSchema.parse({ ...base.session, persist: false }),
      memory: MemoryConfigSchema.parse(base.memory),
      media: (() => { const media = MediaConfigSchema.parse(base.media); return { ...media, vision: { ...media.vision, apiKey: '' }, ocr: { ...media.ocr, apiKey: '' } }; })(),
    };
    const sessions: SessionManagerLike = {
      async get() { return { key: 'k', botId: 'main', channelId: 'c', userId: 'u', messages: [], updatedAt: 0 }; },
      async append() {},
      async buildContext(_key, systemPrompt) { return [{ role: 'system', content: systemPrompt }]; },
      async clear() {}, async sweep() { return 0; }, size() { return 1; },
    };
    const captured: ChatMessage[] = [];
    const outgoing: string[] = [];
    const pipeline = new MessagePipeline({
      config, sessions, songs,
      topicBuffer: new TopicBuffer({ quietMs: 5 }),
      provider: {
        name: 'test', model: 'test',
        async chat(messages) { captured.push(...messages); return { content: '好听', model: 'test', ms: 0 }; },
        async health() { return { ok: true }; },
      },
      events: new EventBus(), logger: createNullLogger(), send: async (out) => { outgoing.push(out.content); },
    });
    return {
      captured,
      outgoing,
      run: (content: string) => pipeline.handle({
        id: `m-${outgoing.length}`, platform: 'discord', botId: 'main', channel: { id: 'c', dm: false },
        author: { id: 'admin1', username: 'admin', bot: false, isBotManager: true },
        content, mentionsBot: true, attachments: [], createdAt: 1,
      }),
    };
  }

  it('injects the song block as its own system message on match', async () => {
    const harness = songsHarness({
      match: async (text: string) => text.includes('达拉崩吧') ? '【歌曲信息】\n达拉崩吧' : undefined,
      status: async () => ({ songs: 10, updatedAt: 1, syncing: false }),
      startSync: async () => ({ accepted: true, message: 'started' }),
    });
    await harness.run('循环达拉崩吧一整天');
    const blocks = harness.captured.filter((m) => m.role === 'system').map((m) => m.content);
    expect(blocks.some((b) => b.includes('【歌曲信息】'))).toBe(true);
    expect(harness.outgoing).toEqual(['好听']);
  });

  it('skips injection without a match and without a bridge', async () => {
    const harness = songsHarness({
      match: async () => undefined,
      status: async () => ({ songs: 0, updatedAt: 0, syncing: false }),
      startSync: async () => ({ accepted: false, message: 'busy' }),
    });
    await harness.run('今天天气不错');
    expect(harness.captured.filter((m) => m.role === 'system').some((m) => m.content.includes('歌曲信息'))).toBe(false);

    const bare = songsHarness(undefined);
    await bare.run('?同步歌曲');
    expect(bare.outgoing[0]).toContain('未启用');
  });

  it('starts a sync and reports busy state', async () => {
    let syncing = false;
    const harness = songsHarness({
      match: async () => undefined,
      status: async () => ({ songs: 3, updatedAt: 1, syncing }),
      startSync: async () => {
        if (syncing) return { accepted: false, message: '已有同步任务在运行，请等待完成后再试。' };
        syncing = true;
        return { accepted: true, message: '🔄 歌曲库同步已开始' };
      },
    });
    await harness.run('?同步歌曲');
    expect(harness.outgoing[0]).toContain('同步已开始');
    await harness.run('?同步歌曲');
    expect(harness.outgoing[1]).toContain('已有同步任务');
  });
});

describe('?广播', () => {  function broadcastHarness() {
    const calls: string[] = [];
    return {
      calls,
      ...build({
        broadcast: {
          preview: async (content: string) => { calls.push(`preview:${content}`); return 'preview-ack'; },
          confirm: async () => { calls.push('confirm'); return 'confirm-ack'; },
          cancel: async () => { calls.push('cancel'); return 'cancel-ack'; },
        },
      }),
    };
  }

  it('previews, confirms and cancels through the bridge', async () => {
    const harness = broadcastHarness();
    await harness.run('?广播 今晚八点活动');
    await harness.run('?广播确认');
    await harness.run('?广播取消');
    expect(harness.calls).toEqual(['preview:今晚八点活动', 'confirm', 'cancel']);
    expect(harness.outgoing).toEqual(['preview-ack', 'confirm-ack', 'cancel-ack']);
  });

  it('asks for content when invoked bare and degrades without a bridge', async () => {
    const harness = broadcastHarness();
    await harness.run('?广播');
    expect(harness.outgoing[0]).toContain('用法');
    expect(harness.calls).toHaveLength(0);

    const bare = build({});
    await bare.run('?广播 hi');
    expect(bare.outgoing[0]).toContain('未启用');
  });
});
