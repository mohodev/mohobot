/**
 * Message-level planner: a single bounded LLM call that decides whether
 * a message is worth replying to after the rule-based social decision
 * already said "reply".
 *
 * Invariants:
 * - Direct summons (DM, @mention) and admin commands bypass the planner.
 * - A single LLM call, same timeout as the main model.
 * - On any failure (timeout, parse error, provider error) the fallback is
 *   'reply' — the planner must never swallow a message.
 */

import type { MohoMessage, ChatMessage } from '../core/types.js';
import type { AIProvider, ChatOptions } from '../ai/types.js';
import type { Logger } from '../core/logger.js';

export interface PlannerDecision {
  action: 'reply' | 'ignore';
  reason: string;
}

export interface MessagePlannerConfig {
  enabled: boolean;
  model?: string;
}

export interface PlannerContext {
  channelName?: string;
  recentMessages: string[];
}

const PLANNER_SYSTEM_PROMPT = [
  '你是一个消息分析器。你的任务是判断AI角色是否应该回复这条消息。',
  '只输出一个JSON对象，格式：{"action":"reply","reason":"..."} 或 {"action":"ignore","reason":"..."}',
  '',
  '判断依据：',
  '- reply: 消息有实质内容、提问、邀请互动、需要回应',
  '- ignore: 纯表情/emoji刷屏、无意义重复、自言自语不需要回应、与AI角色完全无关的对话',
  '',
  '只输出JSON，不要解释。',
].join('\n');

export class MessagePlanner {
  readonly #provider: AIProvider;
  readonly #config: MessagePlannerConfig;
  readonly #logger: Logger;

  constructor(provider: AIProvider, config: MessagePlannerConfig, logger: Logger) {
    this.#provider = provider;
    this.#config = config;
    this.#logger = logger.child({ component: 'message-planner' });
  }

  get enabled(): boolean { return this.#config.enabled; }

  async plan(message: MohoMessage, context: PlannerContext, timeoutMs: number, signal?: AbortSignal): Promise<PlannerDecision> {
    if (!this.#config.enabled) return { action: 'reply', reason: 'planner disabled' };
    if (message.channel.dm || message.mentionsBot) return { action: 'reply', reason: 'direct summon bypasses planner' };
    if (message.author.isBotManager) return { action: 'reply', reason: 'admin bypasses planner' };

    try {
      const userContent = [
        context.channelName ? `频道：${context.channelName}` : '',
        context.recentMessages.length > 0 ? `最近消息：\n${context.recentMessages.slice(-5).join('\n')}` : '',
        `当前消息（${message.author.username}）：${message.content}`,
      ].filter(Boolean).join('\n');

      const messages: ChatMessage[] = [
        { role: 'system', content: PLANNER_SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ];

      const opts: ChatOptions = {
        model: this.#config.model,
        temperature: 0.1,
        timeoutMs,
        signal,
        stream: false,
        task: 'planner',
      };

      const response = await this.#provider.chat(messages, opts);
      return this.#parse(response.content);
    } catch (error) {
      this.#logger.warn(
        { err: error instanceof Error ? error.message : String(error), messageId: message.id },
        'planner call failed; falling back to reply',
      );
      return { action: 'reply', reason: 'planner error fallback' };
    }
  }

  #parse(raw: string): PlannerDecision {
    const trimmed = raw.trim();
    const match = trimmed.match(/\{[^}]*"action"\s*:\s*"(reply|ignore)"[^}]*"reason"\s*:\s*"([^"]*)"[^}]*\}/);
    if (!match) {
      const matchReversed = trimmed.match(/\{[^}]*"reason"\s*:\s*"([^"]*)"[^}]*"action"\s*:\s*"(reply|ignore)"[^}]*\}/);
      if (matchReversed) return { action: matchReversed[2]! as 'reply' | 'ignore', reason: matchReversed[1]! };
      this.#logger.debug({ raw: trimmed.slice(0, 200) }, 'planner output unparseable; falling back to reply');
      return { action: 'reply', reason: 'unparseable planner output' };
    }
    return { action: match[1]! as 'reply' | 'ignore', reason: match[2]! };
  }
}
