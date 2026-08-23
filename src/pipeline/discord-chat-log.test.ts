import { describe, expect, it } from 'vitest';
import { AIConfigSchema, BotConfigSchema, MediaConfigSchema, MemoryConfigSchema, SessionConfigSchema } from '../config/schema.js';
import { EventBus } from '../core/event.js';
import { createNullLogger } from '../core/logger.js';
import { discordChatLog } from '../core/discord-chat-log.js';
import type { OutboundMessage } from '../core/types.js';
import type { SessionManagerLike } from '../session/types.js';
import { MessagePipeline, type PipelineDeps } from './pipeline.js';

function buildConfig() {
  const base = BotConfigSchema.parse({ id: 'main', rateLimit: { enabled: false } });
  return {
    ...base,
    ai: AIConfigSchema.parse({ ...base.ai, apiKey: 'test-key-123456', maxTokens: 0 }),
    session: SessionConfigSchema.parse({ ...base.session, persist: false }),
    memory: MemoryConfigSchema.parse(base.memory),
    media: { ...MediaConfigSchema.parse(base.media), vision: { ...MediaConfigSchema.parse(base.media).vision, apiKey: '' }, ocr: { ...MediaConfigSchema.parse(base.media).ocr, apiKey: '' } },
  };
}

const sessions: SessionManagerLike = {
  async get() { return { key: 'k', botId: 'main', channelId: 'c', userId: 'u', messages: [], updatedAt: 0 }; },
  async append() {}, async buildContext(_key, systemPrompt) { return [{ role: 'user', content: 'hi' }]; },
  async clear() {}, async sweep() { return 0; }, size() { return 0; },
};

const REPLY = '```reply-plan\n{"action":"reply","style":"chat","quote":true,"segments":[{"text":"seg one","pauseAfterMs":0},{"text":"seg two"}]}\n```';

function buildPipeline(send: (out: OutboundMessage) => Promise<void>, reply = REPLY): MessagePipeline {
  const deps: PipelineDeps = {
    config: buildConfig(),
    sessions,
    provider: { name: 'test', model: 'test', async chat() { return { content: reply, model: 'test', ms: 0 }; }, async health() { return { ok: true }; } },
    events: new EventBus(), logger: createNullLogger(), send,
  };
  return new MessagePipeline(deps);
}

function inbound(platform: 'discord' | 'console', id: string) {
  return { id, platform, botId: 'main', channel: { id: 'chan-9', dm: false }, author: { id: 'user-9', username: 'u9', bot: false }, content: 'hello bot', mentionsBot: true, attachments: [], createdAt: 42 };
}

describe('pipeline Discord chat log wiring', () => {
  it('records inbound and every delivered outbound segment for discord traffic', async () => {
    discordChatLog.clear();
    await buildPipeline(async () => {}).handle(inbound('discord', 'm1'));
    const items = discordChatLog.query();
    expect(items).toHaveLength(3);
    expect(items[2]).toMatchObject({ direction: 'in', channelId: 'chan-9', userId: 'user-9', summary: 'hello bot', outcome: 'received' });
    expect(items[1]).toMatchObject({ direction: 'out', userId: 'main', summary: 'seg one', outcome: 'delivered' });
    expect(items[0]).toMatchObject({ direction: 'out', summary: 'seg two', outcome: 'delivered' });
    const traceId = items[0]!.traceId!;
    expect(traceId).toMatch(/^ct_/);
    expect(items.every((entry) => entry.traceId === traceId)).toBe(true);
  });

  it('never records console traffic', async () => {
    discordChatLog.clear();
    await buildPipeline(async () => {}).handle(inbound('console', 'm2'));
    expect(discordChatLog.query()).toEqual([]);
  });

  it('marks outbound entries delivery_failed when sending throws', async () => {
    discordChatLog.clear();
    await buildPipeline(async () => { throw new Error('gateway down'); }).handle(inbound('discord', 'm3'));
    const items = discordChatLog.query().filter((entry) => entry.direction === 'out');
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.every((entry) => entry.outcome === 'delivery_failed')).toBe(true);
  });
});
