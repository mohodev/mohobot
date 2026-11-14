import { describe, expect, it, vi } from 'vitest';
import { AIConfigSchema, BotConfigSchema, MediaConfigSchema, MemoryConfigSchema, SessionConfigSchema } from '../config/schema.js';
import { createNullLogger } from '../core/logger.js';
import type { ChatMessage, MohoMessage } from '../core/types.js';
import { buildConversationContext } from './conversation-context.js';

function config() {
  const base = BotConfigSchema.parse({ id: 'ctx-bot', name: 'Context Bot', systemPrompt: 'base persona' });
  const media = MediaConfigSchema.parse(base.media);
  return {
    ...base,
    ai: AIConfigSchema.parse({ ...base.ai, apiKey: 'test-key-context-123456' }),
    session: SessionConfigSchema.parse(base.session),
    memory: MemoryConfigSchema.parse(base.memory),
    media: { ...media, vision: { ...media.vision, apiKey: '' }, ocr: { ...media.ocr, apiKey: '' } },
  };
}

function message(): MohoMessage {
  return {
    id: 'message-1',
    platform: 'discord',
    botId: 'ctx-bot',
    channel: { id: 'channel-1', dm: true },
    author: { id: 'user-1', username: 'Alice', bot: false },
    content: 'hello',
    mentionsBot: true,
    attachments: [],
    createdAt: 123,
  };
}

describe('buildConversationContext', () => {
  it('persists before reading history and assembles ordered, provenance-wrapped blocks', async () => {
    const botConfig = config();
    const calls: string[] = [];
    const sessions = {
      append: vi.fn(async () => { calls.push('append'); }),
      buildContext: vi.fn(async (_key: unknown, _prompt: string) => {
        calls.push('build');
        return [
          { role: 'system', content: 'base persona' },
          { role: 'system', content: '[Recalled preference] prefers tea' },
          { role: 'user', content: 'previous user message' },
          { role: 'assistant', content: 'previous assistant reply' },
        ] as ChatMessage[];
      }),
      getSummary: vi.fn(async () => {
        calls.push('summary');
        return 'older history summary';
      }),
    };
    const plugins = {
      runBeforeAI: vi.fn(async (_message: MohoMessage, messages: ChatMessage[]) => {
        calls.push('plugin');
        messages.push({ role: 'system', content: 'plugin context' });
      }),
    };

    const result = await buildConversationContext(
      {
        message: message(),
        key: { botId: 'ctx-bot', channelId: 'channel-1', userId: 'user-1' },
        prompt: 'hello',
        rawContent: 'hello',
        attachments: { accepted: [], rejected: [], totalBytes: 0, context: '' },
      },
      {
        config: botConfig,
        sessions,
        world: { context: async () => { calls.push('world'); return 'world context'; } },
        logger: createNullLogger(),
        emotion: { buildContextBlock: async () => { calls.push('emotion'); return 'emotion context'; } },
        songs: { match: async () => { calls.push('songs'); return 'song context'; } },
        plugins,
      },
    );

    expect(calls[0]).toBe('append');
    expect(calls[1]).toBe('build');
    expect(calls.at(-1)).toBe('plugin');
    expect(sessions.append).toHaveBeenCalledWith(
      { botId: 'ctx-bot', channelId: 'channel-1', userId: 'user-1' },
      expect.objectContaining({
        role: 'user',
        content: 'hello',
        sourceMessageId: 'message-1',
        sourcePlatform: 'discord',
        createdAt: 123,
      }),
    );

    expect(result.messages[0]).toEqual({ role: 'system', content: 'base persona' });
    expect(result.messages[1]?.content).toContain('上下文锚点');
    expect(result.messages[2]).toEqual({ role: 'system', content: 'world context' });
    expect(result.messages.some((item) => item.content.includes('历史对话摘要'))).toBe(true);
    expect(result.messages.some((item) => item.content === 'emotion context')).toBe(true);
    expect(result.messages.some((item) => item.content === 'song context')).toBe(true);
    expect(result.messages.at(-1)).toEqual({ role: 'system', content: 'plugin context' });

    const recalled = result.messages.find((item) => item.content.includes('untrusted_data') && item.content.includes('memory'));
    expect(recalled).toBeDefined();
    expect(JSON.parse(recalled!.content)).toMatchObject({ trust: 'untrusted', source: 'memory' });
    const userTurn = result.messages.find((item) => item.content.includes('untrusted_data') && item.content.includes('user'));
    expect(userTurn).toBeDefined();
    expect(JSON.parse(userTurn!.content)).toMatchObject({ trust: 'untrusted', source: 'user' });
    expect(result.personaText).toBe('base persona');
  });

  it('degrades failed optional context lookups without failing the conversation', async () => {
    const botConfig = config();
    const sessions = {
      append: async () => undefined,
      buildContext: async () => [{ role: 'system', content: 'persona' }] as ChatMessage[],
      getSummary: async () => { throw new Error('summary unavailable'); },
    };
    const result = await buildConversationContext(
      {
        message: message(),
        key: { botId: 'ctx-bot', channelId: 'channel-1', userId: 'user-1' },
        prompt: 'hello',
        rawContent: 'hello',
        attachments: { accepted: [], rejected: [], totalBytes: 0, context: '' },
      },
      {
        config: botConfig,
        sessions,
        world: { context: async () => { throw new Error('world unavailable'); } },
        logger: createNullLogger(),
        emotion: { buildContextBlock: async () => { throw new Error('emotion unavailable'); } },
        songs: { match: async () => { throw new Error('songs unavailable'); } },
      },
    );

    expect(result.personaText).toBe('base persona');
    expect(result.messages[0]).toEqual({ role: 'system', content: 'base persona' });
    expect(result.messages.some((item) => item.content.includes('历史对话摘要'))).toBe(false);
    expect(result.messages.some((item) => item.content === '')).toBe(true);
  });
});
