/**
 * Pipeline integration for the relationship (emotion) system.
 *
 * The contract under test: the emotion block reaches the model as its own
 * system message (never as user content), a failing block builder costs no
 * reply, and the turn is scheduled exactly once after a delivered reply.
 */

import { describe, expect, it } from 'vitest';

import { AIConfigSchema, BotConfigSchema, MediaConfigSchema, MemoryConfigSchema, SessionConfigSchema } from '../config/schema.js';
import { EventBus } from '../core/event.js';
import { createNullLogger } from '../core/logger.js';
import type { ChatMessage, MohoMessage } from '../core/types.js';
import type { SessionManagerLike } from '../session/types.js';
import { MessagePipeline, type EmotionBridge } from './pipeline.js';
import { TopicBuffer } from './topic-buffer.js';

const EMOTION_BLOCK = '【情感回应风格】\n好感度：12 | 亲密度：8';

function build(chat: (messages: Array<{ role: string; content: string }>) => Promise<{ content: string; model: string; ms: number }>, emotion: EmotionBridge | undefined) {
  const base = BotConfigSchema.parse({ id: 'main', rateLimit: { enabled: false } });
  const config = {
    ...base,
    ai: AIConfigSchema.parse({ ...base.ai, apiKey: 'test-key-123456', maxTokens: 0 }),
    session: SessionConfigSchema.parse({ ...base.session, persist: false }),
    memory: MemoryConfigSchema.parse(base.memory),
    media: (() => { const media = MediaConfigSchema.parse(base.media); return { ...media, vision: { ...media.vision, apiKey: '' }, ocr: { ...media.ocr, apiKey: '' } }; })(),
  };
  const appended: ChatMessage[] = [];
  const sessions: SessionManagerLike = {
    async get() { return { key: 'k', botId: 'main', channelId: 'c', userId: 'u', messages: [], updatedAt: 0 }; },
    async append(_key, message) { appended.push(message); },
    async buildContext(key, systemPrompt) { return [{ role: 'system', content: systemPrompt }, ...appended]; },
    async clear() {}, async sweep() { return 0; }, size() { return 1; },
  };
  const captured: Array<Array<{ role: string; content: string }>> = [];
  const outgoing: string[] = [];
  const sent: string[] = [];
  const pipeline = new MessagePipeline({
    config, sessions, emotion,
    topicBuffer: new TopicBuffer({ quietMs: 5 }),
    provider: {
      name: 'test', model: 'test',
      async chat(messages) {
        captured.push(messages);
        const response = await chat(messages);
        return { content: response.content, model: 'test', ms: 0 };
      },
      async health() { return { ok: true }; },
    },
    events: new EventBus(), logger: createNullLogger(), send: async (out) => { outgoing.push(out.content); },
  });
  return {
    pipeline,
    captured,
    outgoing,
    async run(content = '你好呀', userId = 'u') {
      await pipeline.handle({
        id: `m-${sent.length}`, platform: 'discord', botId: 'main', channel: { id: 'c', dm: false },
        author: { id: userId, username: 'user', bot: false }, content, mentionsBot: true,
        attachments: [], createdAt: 1,
      });
      sent.push(content);
    },
  };
}

describe('pipeline emotion integration', () => {
  it('injects the relationship block as a system message and schedules the turn', async () => {
    let scheduled: Array<[string, string, string]> = [];
    const emotion: EmotionBridge = {
      async buildContextBlock(userKey) { return userKey === 'u' ? EMOTION_BLOCK : ''; },
      scheduleTurn(userKey, userText, aiReply) { scheduled.push([userKey, userText, aiReply]); },
      async getSnapshot() { throw new Error('unused'); },
      async ranking() { return []; },
      setFavor() {}, setIntimacy() {},
    };
    const harness = build(async () => ({ content: '在呢～', model: 'test', ms: 0 }), emotion);
    await harness.run('你好呀');

    const messages = harness.captured[0] ?? [];
    const blocks = messages.filter((m) => m.role === 'system').map((m) => m.content);
    expect(blocks).toContain(EMOTION_BLOCK);
    // The relationship state must never be framed as the user's own message.
    expect(messages.some((m) => m.role === 'user' && m.content.includes('好感度'))).toBe(false);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toEqual(['u', '你好呀', '在呢～']);
  });

  it('replies normally when the emotion block builder throws', async () => {
    const emotion: EmotionBridge = {
      async buildContextBlock() { throw new Error('store is on fire'); },
      scheduleTurn() { throw new Error('unused'); },
      async getSnapshot() { throw new Error('unused'); },
      async ranking() { return []; },
      setFavor() {}, setIntimacy() {},
    };
    const harness = build(async () => ({ content: '还在的', model: 'test', ms: 0 }), emotion);
    await harness.run('你好');
    expect(harness.outgoing).toContain('还在的');
  });

  it('omits the block entirely when emotion is not wired', async () => {
    const harness = build(async () => ({ content: '嗯', model: 'test', ms: 0 }), undefined);
    await harness.run('你好');
    const blocks = (harness.captured[0] ?? []).filter((m) => m.role === 'system').map((m) => m.content);
    expect(blocks.some((b) => b.includes('情感回应风格'))).toBe(false);
    expect(harness.outgoing).toEqual(['嗯']);
  });

  it('isolates each user\'s relationship state', async () => {
    const asked: string[] = [];
    const emotion: EmotionBridge = {
      async buildContextBlock(userKey) { asked.push(userKey); return `占位:${userKey}`; },
      scheduleTurn() {},
      async getSnapshot() { throw new Error('unused'); },
      async ranking() { return []; },
      setFavor() {}, setIntimacy() {},
    };
    const harness = build(async () => ({ content: '好', model: 'test', ms: 0 }), emotion);
    await harness.run('你好', 'alice');
    await harness.run('你也好', 'bob');
    expect(asked).toEqual(['alice', 'bob']);
    const first = (harness.captured[0] ?? []).filter((m) => m.role === 'system').map((m) => m.content);
    const second = (harness.captured[1] ?? []).filter((m) => m.role === 'system').map((m) => m.content);
    expect(first).toContain('占位:alice');
    expect(second).toContain('占位:bob');
  });
});
