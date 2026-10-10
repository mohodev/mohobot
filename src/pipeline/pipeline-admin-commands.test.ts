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
import type { SessionManagerLike } from '../session/types.js';
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

describe('?用量', () => {  it('reports through the bridge and parses the day window', async () => {
    const seen: number[] = [];
    const harness = build({ usage: { report: async (days: number) => { seen.push(days); return `report-${days}`; } } });
    await harness.run('?用量');
    await harness.run('?用量 7');
    await harness.run('?用量 nonsense');
    expect(harness.outgoing).toEqual(['report-1', 'report-7', 'report-1']);
    expect(seen).toEqual([1, 7, 1]);
  });

  it('degrades gracefully without a bridge', async () => {
    const harness = build({});
    await harness.run('?用量');
    expect(harness.outgoing[0]).toContain('未启用');
  });

  it('stays silent for non-admins', async () => {
    const harness = build({ usage: { report: async () => 'never' } }, );
    await harness.run('?用量', false);
    expect(harness.outgoing).toHaveLength(0);
  });
});

describe('?广播', () => {
  function broadcastHarness() {
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
