import { describe, expect, it } from 'vitest';
import { AIConfigSchema, BotConfigSchema, MediaConfigSchema, MemoryConfigSchema, SessionConfigSchema } from '../config/schema.js';
import { EventBus } from '../core/event.js';
import { createNullLogger } from '../core/logger.js';
import type { ChatMessage, MohoMessage } from '../core/types.js';
import type { SessionManagerLike } from '../session/types.js';
import { ChatToolRegistry } from '../ai/tools.js';
import { MessagePipeline } from './pipeline.js';

function makeConfig(tools: { enabled: boolean; maxRounds?: number; allow?: string[] }) {
  const base = BotConfigSchema.parse({ id: 'tools', rateLimit: { enabled: false } });
  const media = MediaConfigSchema.parse(base.media);
  return {
    ...base,
    ai: AIConfigSchema.parse({ ...base.ai, apiKey: 'k', tools: { enabled: tools.enabled, maxRounds: tools.maxRounds ?? 3, allow: tools.allow ?? [] } }),
    session: SessionConfigSchema.parse({ ...base.session, persist: false }),
    memory: MemoryConfigSchema.parse(base.memory),
    media: { ...media, vision: { ...media.vision, apiKey: '' }, ocr: { ...media.ocr, apiKey: '' } },
  };
}

function dm(content: string): MohoMessage {
  return { id: 'm1', platform: 'console', botId: 'tools', channel: { id: 'c', dm: true }, author: { id: 'u', username: 'u', bot: false }, content, mentionsBot: true, attachments: [], createdAt: 0 };
}

const sessions: SessionManagerLike = {
  async get() { return { key: 'k', botId: 'tools', channelId: 'c', messages: [], updatedAt: 0 }; },
  async append() {},
  async buildContext() { return [{ role: 'user', content: '点歌' }]; },
  async clear() {},
  async sweep() { return 0; },
  size() { return 0; },
};

function songRegistry(executed: string[]): ChatToolRegistry {
  const registry = new ChatToolRegistry();
  registry.register({
    definition: { type: 'function', function: { name: 'search_song', description: '查歌', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
    handler: (args) => { executed.push(String(args.query)); return { found: true, info: '《测试歌》' }; },
  });
  return registry;
}

describe('LLM tool-calling in the reply path', () => {
  it('runs a tool loop: model tool_call -> tool result -> final text delivered', async () => {
    const executed: string[] = [];
    const calls: Array<{ tools?: unknown; messages: ChatMessage[] }> = [];
    let n = 0;
    const sent: string[] = [];
    const provider = {
      name: 'mock', model: 'mock',
      async chat(messages: ChatMessage[], options?: { tools?: unknown }) {
        calls.push({ tools: options?.tools, messages });
        n += 1;
        if (n === 1) return { content: '', model: 'mock', ms: 1, toolCalls: [{ id: 'c1', name: 'search_song', arguments: '{"query":"测试"}' }] };
        return { content: '找到了这首歌', model: 'mock', ms: 1 };
      },
      async health() { return { ok: true }; },
    };
    const pipeline = new MessagePipeline({
      config: makeConfig({ enabled: true }), provider, sessions, chatTools: songRegistry(executed),
      events: new EventBus(), logger: createNullLogger(), send: async (out) => { sent.push(out.content); },
    });
    await pipeline.handle(dm('点歌'));
    expect(sent).toEqual(['找到了这首歌']);
    expect(executed).toEqual(['测试']);
    expect(n).toBe(2);
    // First call offered the tool; the thread then carried an assistant
    // tool_calls turn and a tool result turn into the second call.
    expect(Array.isArray(calls[0]!.tools) && (calls[0]!.tools as unknown[]).length).toBe(1);
    const second = calls[1]!.messages as unknown as Array<Record<string, unknown>>;
    expect(second.some((m) => m.role === 'assistant' && Array.isArray(m.toolCalls))).toBe(true);
    expect(second.some((m) => m.role === 'tool' && String(m.content).includes('测试歌'))).toBe(true);
  });

  it('leaves the single-call path untouched when tools are disabled', async () => {
    const executed: string[] = [];
    let sawTools: unknown = 'unset';
    const sent: string[] = [];
    const provider = {
      name: 'mock', model: 'mock',
      async chat(_m: ChatMessage[], options?: { tools?: unknown }) { sawTools = options?.tools; return { content: '普通回复', model: 'mock', ms: 1 }; },
      async health() { return { ok: true }; },
    };
    const pipeline = new MessagePipeline({
      config: makeConfig({ enabled: false }), provider, sessions, chatTools: songRegistry(executed),
      events: new EventBus(), logger: createNullLogger(), send: async (out) => { sent.push(out.content); },
    });
    await pipeline.handle(dm('你好'));
    expect(sent).toEqual(['普通回复']);
    expect(executed).toEqual([]);
    expect(sawTools).toBeUndefined();
  });

  it('respects maxRounds and stops looping when the model never stops calling tools', async () => {
    const executed: string[] = [];
    let n = 0;
    const provider = {
      name: 'mock', model: 'mock',
      async chat() { n += 1; return { content: '', model: 'mock', ms: 1, toolCalls: [{ id: `c${n}`, name: 'search_song', arguments: '{"query":"x"}' }] }; },
      async health() { return { ok: true }; },
    };
    const pipeline = new MessagePipeline({
      config: makeConfig({ enabled: true, maxRounds: 2 }), provider, sessions, chatTools: songRegistry(executed),
      events: new EventBus(), logger: createNullLogger(), send: async () => {},
    });
    await pipeline.handle(dm('点歌'));
    expect(n).toBe(2); // exactly maxRounds calls, no infinite loop
    expect(executed).toEqual(['x', 'x']);
  });

  it('honours the tool allowlist (empty allow = no tools offered)', async () => {
    const executed: string[] = [];
    let sawTools: unknown = 'unset';
    const provider = {
      name: 'mock', model: 'mock',
      async chat(_m: ChatMessage[], options?: { tools?: unknown }) { sawTools = options?.tools; return { content: '好', model: 'mock', ms: 1 }; },
      async health() { return { ok: true }; },
    };
    const pipeline = new MessagePipeline({
      config: makeConfig({ enabled: true, allow: ['some_other_tool'] }), provider, sessions, chatTools: songRegistry(executed),
      events: new EventBus(), logger: createNullLogger(), send: async () => {},
    });
    await pipeline.handle(dm('点歌'));
    expect(sawTools).toBeUndefined(); // allowlist excluded search_song -> single call
    expect(executed).toEqual([]);
  });
});
