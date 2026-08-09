import { describe, expect, it, vi } from 'vitest';
import { AIError, type AIProvider, type AIResponse } from '../ai/types.js';
import { EventBus } from '../core/event.js';
import { createNullLogger } from '../core/logger.js';
import type { ChatMessage, MohoMessage, OutboundMessage } from '../core/types.js';
import {
  BotConfigSchema,
  AIConfigSchema,
  MemoryConfigSchema,
  SessionConfigSchema,
  type ResolvedBotConfig,
} from '../config/schema.js';
import type { Session, SessionKeyInput, SessionManagerLike } from '../session/types.js';
import { MessagePipeline } from './pipeline.js';

function makeConfig(overrides: Record<string, unknown> = {}): ResolvedBotConfig {
  const base = BotConfigSchema.parse({ id: 'main', ...overrides });
  return {
    ...base,
    ai: AIConfigSchema.parse(base.ai),
    session: SessionConfigSchema.parse(base.session),
    memory: MemoryConfigSchema.parse(base.memory),
  };
}

function makeMessage(content: string, overrides: Partial<MohoMessage> = {}): MohoMessage {
  return {
    id: 'm1',
    platform: 'console',
    botId: 'main',
    channel: { id: 'c1', dm: true },
    author: { id: 'u1', username: 'tester', bot: false },
    content,
    mentionsBot: true,
    attachments: [],
    createdAt: Date.now(),
    ...overrides,
  };
}

/** Minimal in-memory session manager; avoids depending on the real one. */
class FakeSessions implements SessionManagerLike {
  readonly store = new Map<string, Session>();
  throwOnAppend = false;

  #key(i: SessionKeyInput): string {
    return `${i.botId}:${i.channelId}:${i.userId}`;
  }

  async get(input: SessionKeyInput): Promise<Session> {
    const key = this.#key(input);
    const existing = this.store.get(key);
    if (existing) return existing;
    const created: Session = {
      key,
      botId: input.botId,
      channelId: input.channelId,
      userId: input.userId,
      messages: [],
      updatedAt: Date.now(),
    };
    this.store.set(key, created);
    return created;
  }

  async append(input: SessionKeyInput, message: ChatMessage): Promise<void> {
    if (this.throwOnAppend) throw new Error('storage down');
    const session = await this.get(input);
    session.messages.push(message);
  }

  async buildContext(input: SessionKeyInput, systemPrompt: string): Promise<ChatMessage[]> {
    const session = await this.get(input);
    return [{ role: 'system', content: systemPrompt }, ...session.messages];
  }

  async clear(input: SessionKeyInput): Promise<void> {
    this.store.delete(this.#key(input));
  }

  async sweep(): Promise<number> {
    return 0;
  }

  size(): number {
    return this.store.size;
  }
}

function makeProvider(impl?: Partial<AIProvider>): AIProvider {
  return {
    name: 'fake',
    model: 'fake-model',
    async chat(): Promise<AIResponse> {
      return { content: 'ai reply', model: 'fake-model', ms: 1 };
    },
    async health() {
      return { ok: true };
    },
    ...impl,
  };
}

function makePipeline(
  overrides: {
    config?: ResolvedBotConfig;
    provider?: AIProvider;
    sessions?: SessionManagerLike;
    typing?: (channelId: string) => Promise<void>;
  } = {},
) {
  const sent: OutboundMessage[] = [];
  const sessions = overrides.sessions ?? new FakeSessions();
  const pipeline = new MessagePipeline({
    config: overrides.config ?? makeConfig(),
    provider: overrides.provider ?? makeProvider(),
    sessions,
    events: new EventBus(),
    logger: createNullLogger(),
    send: async (out) => void sent.push(out),
    typing: overrides.typing,
  });
  return { pipeline, sent, sessions };
}

describe('MessagePipeline', () => {
  it('replies with the AI response', async () => {
    const { pipeline, sent } = makePipeline();
    await pipeline.handle(makeMessage('hello'));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.content).toBe('ai reply');
    expect(pipeline.stats().replied).toBe(1);
  });

  it('sends the system prompt plus history to the provider', async () => {
    const chat = vi.fn<AIProvider['chat']>(async () => ({ content: 'ok', model: 'm', ms: 1 }));
    const { pipeline } = makePipeline({ provider: makeProvider({ chat }) });
    await pipeline.handle(makeMessage('question'));

    const messages = chat.mock.calls[0]?.[0] ?? [];
    expect(messages[0]?.role).toBe('system');
    expect(messages.at(-1)?.content).toBe('question');
  });

  it('keeps running and sends a friendly fallback when the AI fails', async () => {
    const provider = makeProvider({
      chat: async () => {
        throw new AIError('upstream exploded', { kind: 'server', status: 500, attempts: 3 });
      },
    });
    const { pipeline, sent } = makePipeline({ provider });
    await pipeline.handle(makeMessage('hi'));

    expect(sent).toHaveLength(1);
    expect(sent[0]?.content).toContain('temporarily unavailable');
    expect(pipeline.stats().aiFailures).toBe(1);
    // The pipeline is still usable afterwards.
    await pipeline.handle(makeMessage('again'));
    expect(pipeline.stats().handled).toBe(2);
  });

  it('maps each AI error kind to its own user-facing message', async () => {
    const kinds = [
      ['timeout', 'timed out'],
      ['rate_limit', 'rate limiting'],
      ['auth', 'credentials'],
    ] as const;
    for (const [kind, expected] of kinds) {
      const provider = makeProvider({
        chat: async () => {
          throw new AIError('x', { kind });
        },
      });
      const { pipeline, sent } = makePipeline({ provider });
      await pipeline.handle(makeMessage('hi'));
      expect(sent[0]?.content).toContain(expected);
    }
  });

  it('never throws when the send function fails', async () => {
    const pipeline = new MessagePipeline({
      config: makeConfig(),
      provider: makeProvider(),
      sessions: new FakeSessions(),
      events: new EventBus(),
      logger: createNullLogger(),
      send: async () => {
        throw new Error('discord down');
      },
    });
    await expect(pipeline.handle(makeMessage('hi'))).resolves.toBeUndefined();
  });

  it('falls back to a bare prompt when the session layer fails', async () => {
    const sessions = new FakeSessions();
    sessions.throwOnAppend = true;
    const chat = vi.fn<AIProvider['chat']>(async () => ({ content: 'ok', model: 'm', ms: 1 }));
    const { pipeline, sent } = makePipeline({ sessions, provider: makeProvider({ chat }) });

    await pipeline.handle(makeMessage('still works'));

    const messages = chat.mock.calls[0]?.[0] ?? [];
    expect(messages).toHaveLength(2);
    expect(sent[0]?.content).toBe('ok');
  });

  it('enforces the per-user rate limit', async () => {
    const config = makeConfig({ rateLimit: { enabled: true, windowMs: 60_000, max: 2 } });
    const { pipeline, sent } = makePipeline({ config });

    await pipeline.handle(makeMessage('1'));
    await pipeline.handle(makeMessage('2'));
    await pipeline.handle(makeMessage('3'));

    expect(pipeline.stats().rateLimited).toBe(1);
    expect(sent.at(-1)?.content).toContain('Slow down');
  });

  it('ignores other bots when configured to', async () => {
    const { pipeline, sent } = makePipeline();
    await pipeline.handle(makeMessage('hi', { author: { id: 'b1', username: 'bot', bot: true } }));
    expect(sent).toHaveLength(0);
    expect(pipeline.stats().skipped).toBe(1);
  });

  it('skips empty content', async () => {
    const { pipeline, sent } = makePipeline();
    await pipeline.handle(makeMessage('   '));
    expect(sent).toHaveLength(0);
  });

  it('handles !help, !status and !reset without calling the AI', async () => {
    const chat = vi.fn(async (): Promise<AIResponse> => ({ content: 'nope', model: 'm', ms: 1 }));
    const { pipeline, sent, sessions } = makePipeline({ provider: makeProvider({ chat }) });

    await pipeline.handle(makeMessage('!help'));
    await pipeline.handle(makeMessage('!status'));
    await sessions.append({ botId: 'main', channelId: 'c1', userId: 'u1' }, { role: 'user', content: 'x' });
    await pipeline.handle(makeMessage('!reset'));

    expect(chat).not.toHaveBeenCalled();
    expect(sent[0]?.content).toContain('Built-in commands');
    expect(sent[1]?.content).toContain('fake-model');
    expect(sent[2]?.content).toContain('cleared');
    expect(sessions.size()).toBe(0);
  });

  it('an unknown ! command falls through to the AI', async () => {
    const chat = vi.fn(async (): Promise<AIResponse> => ({ content: 'ai handled it', model: 'm', ms: 1 }));
    const { pipeline, sent } = makePipeline({ provider: makeProvider({ chat }) });
    await pipeline.handle(makeMessage('!nosuchcommand'));
    expect(chat).toHaveBeenCalledOnce();
    expect(sent[0]?.content).toBe('ai handled it');
  });

  it('replies with the configured fallback when the AI returns empty text', async () => {
    const provider = makeProvider({ chat: async () => ({ content: '   ', model: 'm', ms: 1 }) });
    const config = makeConfig();
    const { pipeline, sent } = makePipeline({ provider, config });
    await pipeline.handle(makeMessage('hi'));
    expect(sent[0]?.content).toBe(config.ai.fallbackReply);
  });

  it('replies inline in a guild channel and plainly in a DM', async () => {
    const { pipeline, sent } = makePipeline();
    await pipeline.handle(makeMessage('dm'));
    await pipeline.handle(makeMessage('guild', { id: 'm2', channel: { id: 'c2', dm: false, guildId: 'g1' } }));

    expect(sent[0]?.replyToId).toBeUndefined();
    expect(sent[1]?.replyToId).toBe('m2');
    expect(sent[1]?.suppressMentions).toBe(true);
  });

  it('does not let a failing typing indicator break the reply', async () => {
    const { pipeline, sent } = makePipeline({
      typing: async () => {
        throw new Error('typing failed');
      },
    });
    await pipeline.handle(makeMessage('hi'));
    expect(sent[0]?.content).toBe('ai reply');
  });
});
