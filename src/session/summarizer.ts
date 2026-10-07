/**
 * Provider-backed summarizer for SessionManager's rolling context summary.
 *
 * Runs on the background `summary` task lane so it can never starve user
 * replies, and is defensive about its own output: an empty answer, a refusal
 * stub or a mock/canned reply is treated as "no summary" and the caller keeps
 * the original turns.
 */

import type { ChatMessage } from '../core/types.js';
import type { Logger } from '../core/logger.js';
import type { AIProvider } from '../ai/types.js';
import type { Summarizer } from './manager.js';

export const SUMMARY_SYSTEM_PROMPT = [
  '你是对话记忆整理器。把给出的聊天记录压缩成一份供之后继续对话使用的"摘要笔记"。',
  '必须保留：参与者是谁及其称呼、彼此关系与态度变化、已确认的事实与偏好、做出的承诺/约定、尚未解决的问题或待办、重要的情绪与语气。',
  '可以丢弃：寒暄、重复内容、无信息量的语气词、过程性的废话。',
  '如果提供了「已有摘要」，把它与新记录合并成一份新的完整摘要，不要丢掉已有摘要里仍然有效的信息。',
  '用第三人称客观陈述，不要编造记录里没有的内容，不要加任何前后缀或解释，只输出摘要正文。',
].join('\n');

function clock(at: number | undefined): string {
  if (at === undefined) return '';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `[${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}] `;
}

/** Render turns as a plain transcript the summarizing model can read. */
export function renderTranscript(messages: ChatMessage[]): string {
  return messages
    .filter((m) => !m.deleted && m.role !== 'system' && m.content.trim())
    .map((m) => `${clock(m.createdAt)}${m.role === 'assistant' ? '我(助手)' : (m.name ?? '用户')}：${m.content.trim()}`)
    .join('\n');
}

export function buildSummaryRequest(input: { previousSummary?: string; messages: ChatMessage[]; maxChars: number }): ChatMessage[] {
  const parts: string[] = [];
  if (input.previousSummary?.trim()) parts.push(`【已有摘要】\n${input.previousSummary.trim()}`);
  parts.push(`【新的聊天记录】\n${renderTranscript(input.messages)}`);
  parts.push(`请输出合并后的完整摘要，控制在 ${Math.max(100, Math.floor(input.maxChars * 0.8))} 字以内。`);
  return [
    { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

/** Offline providers answer with canned text; never store that as memory. */
export function isOfflineProvider(provider: AIProvider): boolean {
  return /(^|:)mock$/i.test(provider.name) || provider.model === 'mock' || provider.model.startsWith('mock:');
}

export interface ProviderSummarizerOptions {
  timeoutMs?: number;
  logger?: Logger;
}

/** Returns undefined for offline providers so the caller keeps plain hard trimming. */
export function createProviderSummarizer(provider: AIProvider, options: ProviderSummarizerOptions = {}): Summarizer | undefined {
  if (isOfflineProvider(provider)) return undefined;
  return async (input) => {
    if (!renderTranscript(input.messages)) return undefined;
    const response = await provider.chat(buildSummaryRequest(input), {
      task: 'summary',
      temperature: 0.3,
      stream: false,
      timeoutMs: options.timeoutMs,
    });
    const text = response.content.trim();
    options.logger?.debug({ model: response.model, ms: response.ms, chars: text.length }, 'context summary produced');
    return text || undefined;
  };
}
