/**
 * The rolling history summary must reach the model as a system message that
 * sits after the persona/time/world blocks and before the live history, and a
 * broken lookup must never cost the user their reply.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AIConfigSchema, BotConfigSchema, MediaConfigSchema, MemoryConfigSchema, SessionConfigSchema } from '../config/schema.js';
import { EventBus } from '../core/event.js';
import { createNullLogger } from '../core/logger.js';
import type { ChatMessage, OutboundMessage } from '../core/types.js';
import type { SessionManagerLike } from '../session/types.js';
import { buildHistorySummaryBlock, MessagePipeline } from './pipeline.js';
import { TopicBuffer } from './topic-buffer.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

async function run(getSummary: SessionManagerLike['getSummary']): Promise<{ sent: ChatMessage[]; outgoing: OutboundMessage[] }> {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mohobot-summary-'));
  roots.push(stateRoot);
  const base = BotConfigSchema.parse({ id: 'main', rateLimit: { enabled: false } });
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
    getSummary,
    async buildContext(_key, systemPrompt) { return [{ role: 'system', content: systemPrompt }, ...history]; },
    async clear() {}, async sweep() { return 0; }, size() { return 1; },
  };
  const sent: ChatMessage[] = [];
  const outgoing: OutboundMessage[] = [];
  const pipeline = new MessagePipeline({
    config,
    stateRoot,
    topicBuffer: new TopicBuffer({ quietMs: 5 }),
    provider: {
      name: 'test', model: 'test',
      async chat(messages) { sent.push(...messages); return { content: '好的。', model: 'test', ms: 0 }; },
      async health() { return { ok: true }; },
    },
    sessions, events: new EventBus(), logger: createNullLogger(), send: async (out) => { outgoing.push(out); },
  });
  await pipeline.handle({
    id: 'm1', platform: 'discord', botId: 'main', channel: { id: 'c', dm: true },
    author: { id: 'u', username: 'user', bot: false }, content: '你还记得我吗', mentionsBot: true, attachments: [], createdAt: 1,
  });
  return { sent, outgoing };
}

describe('history summary injection', () => {
  it('injects the summary as a system block between the world context and the live history', async () => {
    const { sent, outgoing } = await run(async () => '用户 alice 下周三面试，希望被鼓励。');
    const index = sent.findIndex((m) => m.role === 'system' && m.content.includes('历史对话摘要'));
    expect(index).toBeGreaterThan(0);
    expect(sent[index]?.content).toContain('用户 alice 下周三面试');
    const firstHistory = sent.findIndex((m) => m.role === 'user');
    expect(index).toBeLessThan(firstHistory);
    expect(sent[0]?.role).toBe('system');
    expect(sent.slice(0, index).every((m) => m.role === 'system')).toBe(true);
    expect(outgoing.length).toBeGreaterThan(0);
  });

  it('adds nothing when the session has no summary', async () => {
    const { sent } = await run(async () => undefined);
    expect(sent.some((m) => m.content.includes('历史对话摘要'))).toBe(false);
  });

  it('adds nothing when the session implementation has no getSummary', async () => {
    const { sent } = await run(undefined);
    expect(sent.some((m) => m.content.includes('历史对话摘要'))).toBe(false);
  });

  it('still replies when the summary lookup throws', async () => {
    const { sent, outgoing } = await run(async () => { throw new Error('storage on fire'); });
    expect(sent.some((m) => m.content.includes('历史对话摘要'))).toBe(false);
    expect(outgoing.map((o) => o.content).join('')).toContain('好的');
  });

  it('labels the block as injected memory, not as a speaker', () => {
    const block = buildHistorySummaryBlock('  笔记  ');
    expect(block).toContain('系统注入，非用户发言');
    expect(block.endsWith('笔记')).toBe(true);
  });
});
