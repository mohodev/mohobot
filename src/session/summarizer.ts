/**
 * Context summary compression.
 *
 * When a session grows past a configured turn count, the oldest turns are
 * folded into a single `summary` block (role `summary`) instead of being
 * dropped by the hard maxMessages/maxChars trim. This mirrors the upstream
 * carefreesongs712/mohobot "AI 总结压缩" behaviour: the summary sits at the
 * front of the transcript, participates in later re-summaries, and any failure
 * degrades to the ordinary hard trim - a broken model call can never lose a
 * reply.
 */

import type { ChatMessage } from '../core/types.js';
import type { Session } from './types.js';

/** System prompt for the compression call. Kept terse: this is a utility call. */
export const SUMMARY_SYSTEM_PROMPT = [
  '你是对话记忆压缩器。把给定的较早聊天记录压缩成一段简明摘要。',
  '要求：',
  '- 用第三人称，保留关键事实：人物、事件、约定、用户偏好、未完成事项。',
  '- 去掉寒暄与冗余，不添加原文没有的内容。',
  '- 若已给出更早的【对话摘要】，请把它与新内容合并成一份连贯摘要。',
  '- 只输出摘要正文，不要解释，不要任何前缀或标记。',
].join('\n');

/** Callback used by the SessionManager; provided by the bot runtime (provider). */
export type Summarize = (messages: ChatMessage[]) => Promise<string>;

export interface CompressionResult {
  /** True when at least one summary block was produced this round. */
  compressed: boolean;
  /** Number of turns folded into the summary. */
  folded: number;
  /** Set when the summarizer threw and the hard trim took over. */
  fallback?: 'summarize_failed';
}

/**
 * Format the messages that should be compressed into a single transcript for
 * the provider. Existing summary blocks are labelled so the model merges them.
 */
export function formatTranscript(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const speaker =
        m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : '已有摘要';
      return `${speaker}：${m.content}`;
    })
    .join('\n');
}

/**
 * Fold the oldest turns of a session into a summary block.
 *
 * Returns `compressed: false` when there is nothing to do (turn count still
 * below the trigger). On summarizer failure it returns `fallback` and leaves
 * the session untouched, so the caller can apply the plain hard trim.
 */
export async function compressSession(
  session: Session,
  triggerMessages: number,
  removeMessages: number,
  keepMessages: number,
  summarize: Summarize,
): Promise<CompressionResult> {
  const summaryBlocks = session.messages.filter((m) => m.role === 'summary' && !m.deleted);
  const turns = session.messages.filter((m) => m.role !== 'summary' && !m.deleted);

  if (turns.length < triggerMessages) return { compressed: false, folded: 0 };

  const toFold = turns.slice(0, Math.max(0, removeMessages));
  if (toFold.length === 0) return { compressed: false, folded: 0 };

  let text: string | undefined;
  try {
    const result = await summarize([...summaryBlocks, ...toFold]);
    if (typeof result === 'string' && result.trim().length > 0) text = result.trim();
  } catch {
    return { compressed: false, folded: toFold.length, fallback: 'summarize_failed' };
  }

  const rest = turns.slice(Math.max(0, removeMessages));
  const kept = rest.slice(-Math.max(1, keepMessages));
  const block: ChatMessage[] = text === undefined
    ? []
    : [{ role: 'summary', content: text }];

  session.messages = [...block, ...kept];
  return { compressed: text !== undefined, folded: toFold.length };
}
