import { describe, expect, it } from 'vitest';

import type { AIProvider, AIResponse, ChatOptions } from '../ai/types.js';
import { MockProvider } from '../ai/mock.js';
import type { ChatMessage } from '../core/types.js';
import { buildSummaryRequest, createProviderSummarizer, isOfflineProvider, renderTranscript, SUMMARY_SYSTEM_PROMPT } from './summarizer.js';

function provider(reply: string | (() => string), name = 'openai-compatible', model = 'real-model'): AIProvider & { seen: Array<{ messages: ChatMessage[]; options?: ChatOptions }> } {
  const seen: Array<{ messages: ChatMessage[]; options?: ChatOptions }> = [];
  return {
    name,
    model,
    seen,
    async chat(messages, options): Promise<AIResponse> {
      seen.push({ messages, options });
      return { content: typeof reply === 'function' ? reply() : reply, model, ms: 1 };
    },
    async health() { return { ok: true }; },
  };
}

const turns: ChatMessage[] = [
  { role: 'user', content: '我下周三要去面试', name: 'alice' },
  { role: 'assistant', content: '加油，需要我帮你准备吗？' },
  { role: 'user', content: '已删除', deleted: true },
  { role: 'system', content: 'ignored system' },
];

describe('renderTranscript', () => {
  it('labels speakers and skips tombstones and system turns', () => {
    const text = renderTranscript(turns);
    expect(text).toContain('alice：我下周三要去面试');
    expect(text).toContain('我(助手)：加油，需要我帮你准备吗？');
    expect(text).not.toContain('已删除');
    expect(text).not.toContain('ignored system');
  });

  it('prefixes a local timestamp when createdAt is known', () => {
    const d = new Date(2026, 7, 23, 13, 45);
    expect(renderTranscript([{ role: 'user', content: 'hi', createdAt: d.getTime() }])).toMatch(/^\[08-23 13:45\] 用户：hi$/);
  });
});

describe('buildSummaryRequest', () => {
  it('sends the instructions as system and carries the previous summary forward', () => {
    const request = buildSummaryRequest({ previousSummary: 'OLD NOTES', messages: turns, maxChars: 1500 });
    expect(request[0]).toEqual({ role: 'system', content: SUMMARY_SYSTEM_PROMPT });
    expect(request[1]?.role).toBe('user');
    expect(request[1]?.content).toContain('【已有摘要】\nOLD NOTES');
    expect(request[1]?.content).toContain('【新的聊天记录】');
    expect(request[1]?.content).toContain('1200 字以内');
  });

  it('omits the previous-summary section when there is none', () => {
    expect(buildSummaryRequest({ messages: turns, maxChars: 1000 })[1]?.content).not.toContain('【已有摘要】');
  });
});

describe('createProviderSummarizer', () => {
  it('calls the provider on the background summary lane without streaming', async () => {
    const p = provider('  摘要正文  ');
    const summarizer = createProviderSummarizer(p, { timeoutMs: 1234 })!;
    expect(await summarizer({ messages: turns, maxChars: 1500 })).toBe('摘要正文');
    expect(p.seen[0]?.options).toMatchObject({ task: 'summary', stream: false, timeoutMs: 1234, temperature: 0.3 });
  });

  it('returns undefined for an empty answer and skips the call for an empty transcript', async () => {
    expect(await createProviderSummarizer(provider('   '))!({ messages: turns, maxChars: 1500 })).toBeUndefined();
    const p = provider('never used');
    expect(await createProviderSummarizer(p)!({ messages: [{ role: 'user', content: 'x', deleted: true }], maxChars: 1500 })).toBeUndefined();
    expect(p.seen).toHaveLength(0);
  });

  it('propagates provider failures so the manager keeps the turns', async () => {
    const boom: AIProvider = { name: 'x', model: 'm', async chat() { throw new Error('upstream 500'); }, async health() { return { ok: false }; } };
    await expect(createProviderSummarizer(boom)!({ messages: turns, maxChars: 1500 })).rejects.toThrow('upstream 500');
  });

  it('refuses to build a summarizer on an offline mock provider', () => {
    expect(isOfflineProvider(new MockProvider())).toBe(true);
    expect(isOfflineProvider(new MockProvider({ model: 'mock:foo' }))).toBe(true);
    expect(isOfflineProvider(provider('x', 'budgeted:mock', 'whatever'))).toBe(true);
    expect(isOfflineProvider(provider('x'))).toBe(false);
    expect(createProviderSummarizer(new MockProvider())).toBeUndefined();
  });
});
