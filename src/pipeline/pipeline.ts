/**
 * Message pipeline - the single path every inbound message travels.
 *
 *   inbound -> guards (rate limit / self / empty)
 *           -> plugin onMessage hooks   (may stop or rewrite)
 *           -> command dispatch          (may stop)
 *           -> session context build
 *           -> plugin onBeforeAI
 *           -> AI provider (timeout + retry live in the provider)
 *           -> plugin onAfterAI
 *           -> session append
 *           -> outbound send
 *
 * Every stage is guarded: a failure degrades to a friendly reply and a log
 * line. Nothing here may throw to the caller.
 */

import { persistChat } from './persist.js';
import { join } from 'node:path';

import type { ResolvedBotConfig } from '../config/schema.js';
import type { EventBus } from '../core/event.js';
import type { Logger } from '../core/logger.js';
import type { ChatMessage, EmbedCard, EmbedField, MohoMessage, OutboundMessage } from '../core/types.js';
import type { AIProvider } from '../ai/types.js';
import { AIError } from '../ai/types.js';
import type { SessionManagerLike } from '../session/types.js';
import type { PluginManager } from '../plugins/manager.js';

/** MohoBot brand color for rich embed cards (hex 0x6a5acd). */
const EMBED_THEME_COLOR = 0x6a5acd;

/**
 * Live time + context anchor injected as a second system message on every
 * AI call. The static systemPrompt (persona) never changes; this carries the
 * current wall-clock so the model is never temporally disoriented and can
 * reference "today", "this afternoon", relative times correctly.
 *
 * Timezone is Asia/Shanghai (UTC+8) - the bot's primary audience. If you need
 * per-user timezone, resolve it from the session and pass it in here.
 */
export function buildContextAnchor(): string {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const date = `${get('year')}年${get('month')}${get('day')}日`;
  const weekday = get('weekday');
  const time = `${get('hour')}:${get('minute')}`;
  return [
    '[上下文锚点 - 系统注入，非用户发言]',
    `当前时间：${date} ${weekday} ${time}（北京时间 UTC+8）`,
    '你不知道确切时间，除非用户明确告知或本锚点提供。涉及时间请以上述为准，不要臆测日期或时刻。',
    '对话历史已按时间顺序提供，请基于上下文连贯回应，记得用户刚才说过的内容。',
  ].join('\n');
}

export interface PipelineDeps {
  config: ResolvedBotConfig;
  provider: AIProvider;
  sessions: SessionManagerLike;
  plugins?: PluginManager;
  events: EventBus;
  logger: Logger;
  send: (out: OutboundMessage) => Promise<void>;
  typing?: (channelId: string) => Promise<void>;
}

export interface PipelineStats {
  handled: number;
  replied: number;
  skipped: number;
  aiFailures: number;
  rateLimited: number;
}

/** Simple sliding-window per-user rate limiter. */
class RateLimiter {
  readonly #hits = new Map<string, number[]>();
  constructor(
    private readonly windowMs: number,
    private readonly max: number,
  ) {}

  allow(key: string): boolean {
    const now = Date.now();
    const list = (this.#hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.max) {
      this.#hits.set(key, list);
      return false;
    }
    list.push(now);
    this.#hits.set(key, list);
    return true;
  }

  /** Drop stale buckets so the map cannot grow without bound. */
  sweep(): void {
    const now = Date.now();
    for (const [key, list] of this.#hits) {
      const live = list.filter((t) => now - t < this.windowMs);
      if (live.length === 0) this.#hits.delete(key);
      else this.#hits.set(key, live);
    }
  }
}

export class MessagePipeline {
  readonly #deps: PipelineDeps;
  readonly #logger: Logger;
  readonly #limiter: RateLimiter;
  readonly #stats: PipelineStats = { handled: 0, replied: 0, skipped: 0, aiFailures: 0, rateLimited: 0 };

  constructor(deps: PipelineDeps) {
    this.#deps = deps;
    this.#logger = deps.logger.child({ component: 'pipeline' });
    this.#limiter = new RateLimiter(deps.config.rateLimit.windowMs, deps.config.rateLimit.max);
  }

  stats(): PipelineStats {
    return { ...this.#stats };
  }

  sweep(): void {
    this.#limiter.sweep();
  }

  /** Entry point. Never throws, never rejects. */
  async handle(message: MohoMessage): Promise<void> {
    // Persist to physical chat log first - fire-and-forget, error swallowed.
    void persistChat(message).catch(() => {});
    try {
      await this.#handleInner(message);
    } catch (error) {
      this.#logger.error(
        { err: error instanceof Error ? error.message : String(error), channel: message.channel.id },
        'pipeline crashed (contained)',
      );
    }
  }

  async #handleInner(message: MohoMessage): Promise<void> {
    this.#stats.handled += 1;
    const cfg = this.#deps.config;
    const log = this.#logger.child({ channel: message.channel.id, user: message.author.id });

    if (message.author.bot && cfg.discord.ignoreBots) {
      this.#stats.skipped += 1;
      return;
    }

    // Plugin hooks first: they may rewrite the content or short-circuit.
    let content = message.content;
    if (this.#deps.plugins) {
      const hook = await this.#deps.plugins.runMessageHooks(message, cfg.disabledPlugins);
      if (hook.content !== undefined) content = hook.content;
      if (hook.reply) {
        await this.#reply(message, hook.reply);
        this.#stats.replied += 1;
      }
      if (hook.stop) {
        this.#stats.skipped += 1;
        return;
      }
    }

    // Built-in + plugin commands, prefix "!".
    const command = this.#parseCommand(content);
    if (command) {
      const handled = await this.#dispatchCommand(command.name, command.args, message, content);
      if (handled) {
        this.#stats.replied += 1;
        return;
      }
    }

    const prompt = content.trim();
    if (prompt.length === 0) {
      this.#stats.skipped += 1;
      return;
    }

    if (cfg.rateLimit.enabled && !this.#limiter.allow(`${message.author.id}`)) {
      this.#stats.rateLimited += 1;
      log.warn('rate limited');
      await this.#reply(message, 'Slow down a little - try again in a few seconds.');
      return;
    }

    const key = { botId: cfg.id, channelId: message.channel.id, userId: message.author.id };

    // Persist the user turn BEFORE building context, so the model sees its
    // own prior replies in the right order (no "echo bot" / repetition bugs).
    try {
      await this.#deps.sessions.append(key, {
        role: 'user',
        content: prompt,
        name: message.author.username,
      });
    } catch (error) {
      this.#logger.warn({ err: String(error) }, 'failed to persist user turn');
    }

    // Build the context window.
    let messages: ChatMessage[] = [];
    let ctxCount = 0;
    try {
      messages = await this.#deps.sessions.buildContext(key, cfg.systemPrompt);
      ctxCount = messages.length;
    } catch (error) {
      this.#logger.warn({ channelId: message.channel.id, error: String(error) }, 'session context build failed; using empty context');
    }

    // Inject a live time/context anchor so the model is never temporally
    // disoriented. Appended to (not replacing) the static system prompt.
    const anchor = buildContextAnchor();
    messages = [
      { role: 'system', content: cfg.systemPrompt },
      { role: 'system', content: anchor },
      ...messages.filter((m) => m.role !== 'system'),
    ];

    if (this.#deps.plugins) {
      await this.#deps.plugins.runBeforeAI(message, messages, cfg.disabledPlugins);
    }

    // Typing indicator is best-effort and must not delay or break the reply.
    if (cfg.discord.typingIndicator && this.#deps.typing) {
      void this.#deps.typing(message.channel.id).catch(() => {});
    }

    let reply: string;
    try {
      const response = await this.#deps.provider.chat(messages, {
        temperature: cfg.ai.temperature,
        maxTokens: cfg.ai.maxTokens,
        timeoutMs: cfg.ai.timeoutMs,
      });
      reply = response.content.trim();
      if (reply.length === 0) reply = cfg.ai.fallbackReply;
    } catch (error) {
      this.#stats.aiFailures += 1;
      const kind = error instanceof AIError ? error.kind : 'unknown';
      const detail = error instanceof Error ? error.message : String(error);
      log.error({ kind, err: detail }, 'AI request failed; replying with fallback');
      await this.#reply(message, this.#friendlyError(kind, cfg.ai.fallbackReply));
      return;
    }

    if (this.#deps.plugins) {
      reply = await this.#deps.plugins.runAfterAI(message, reply, cfg.disabledPlugins);
    }

    try {
      const sessions = this.#deps.sessions;
      const assistantTurn = { role: 'assistant' as const, content: reply };
      if (typeof sessions.completeExchange === 'function') {
        await sessions.completeExchange(key, { role: 'user', content: prompt, name: message.author.username }, assistantTurn);
      } else {
        await sessions.append(key, assistantTurn);
      }
    } catch (error) {
      log.warn({ err: error instanceof Error ? error.message : String(error) }, 'failed to persist assistant turn');
    }

    await this.#reply(message, reply);
    this.#stats.replied += 1;
  }

  #parseCommand(content: string): { name: string; args: string[] } | undefined {
    const trimmed = content.trim();
    if (!trimmed.startsWith('!') || trimmed.length < 2) return undefined;
    const parts = trimmed.slice(1).split(/\s+/);
    const name = parts[0]?.toLowerCase();
    if (!name) return undefined;
    return { name, args: parts.slice(1) };
  }

  async #dispatchCommand(name: string, args: string[], message: MohoMessage, raw: string): Promise<boolean> {
    const cfg = this.#deps.config;
    const reply = (text: string | EmbedCard): Promise<void> => this.#reply(message, text);

    if (name === 'reset' || name === 'clear') {
      await this.#deps.sessions
        .clear({ botId: cfg.id, channelId: message.channel.id, userId: message.author.id })
        .catch(() => {});
      await reply({ description: 'Context cleared.', color: EMBED_THEME_COLOR, footer: cfg.name });
      return true;
    }
    if (name === 'help') {
      const pluginCommands = this.#deps.plugins ? [...this.#deps.plugins.commands().keys()] : [];
      const fields: EmbedField[] = [
        { name: '基础', value: '`!help` 帮助 · `!reset` 清上下文 · `!status` 运行状态', inline: false },
      ];
      if (pluginCommands.length > 0) {
        // one field per command group, 25 fields max
        const cmds = pluginCommands.map((c) => '`!' + c + '`');
        for (let i = 0; i < cmds.length; i += 6) {
          fields.push({
            name: i === 0 ? '插件命令' : '\u200b',
            value: cmds.slice(i, i + 6).join('  '),
            inline: false,
          });
        }
      }
      await reply({
        title: '墨染荷韵 · 指令帮助',
        description: '发送 `!` 开头的指令与我交互。',
        color: EMBED_THEME_COLOR,
        fields,
      });
      return true;
    }
    if (name === 'status') {
      const s = this.stats();
      await reply({
        title: 'Status',
        color: EMBED_THEME_COLOR,
        fields: [
          { name: 'Bot', value: cfg.name, inline: true },
          { name: 'Model', value: this.#deps.provider.model, inline: true },
          { name: 'Sessions', value: String(this.#deps.sessions.size()), inline: true },
          { name: 'Handled', value: String(s.handled), inline: true },
          { name: 'Replied', value: String(s.replied), inline: true },
          { name: 'AI failures', value: String(s.aiFailures), inline: true },
          { name: 'Rate limited', value: String(s.rateLimited), inline: true },
        ],
        footer: cfg.name,
      });
      return true;
    }

    if (!this.#deps.plugins) return false;
    const known = this.#deps.plugins.commands();
    if (!known.has(name)) return false;

    const result = await this.#deps.plugins.executeCommand(name, { message, args, raw, reply }, cfg.disabledPlugins);
    if (typeof result === 'string') {
      if (result.length > 0) await reply(result);
    } else if (result !== undefined && result !== null) {
      await reply(result);
    }
    return true;
  }

  async #reply(message: MohoMessage, content: string | EmbedCard): Promise<void> {
    const embed = typeof content === 'object' ? content : undefined;
    const text = typeof content === 'object' ? '' : content;
    const safeContent = embed && text.length === 0 ? (embed.description ?? '') : text;
    try {
      await this.#deps.send({
        channelId: message.channel.id,
        content: safeContent,
        embed,
        replyToId: message.channel.dm ? undefined : message.id,
        suppressMentions: true,
      });
    } catch (error) {
      this.#logger.error(
        { err: error instanceof Error ? error.message : String(error), channel: message.channel.id },
        'send failed',
      );
    }
  }

  #friendlyError(kind: string, fallback: string): string {
    switch (kind) {
      case 'timeout':
        return 'That took too long and timed out. Try again?';
      case 'rate_limit':
        return 'Upstream is rate limiting me right now - give it a moment.';
      case 'auth':
        return 'My AI credentials are invalid. An admin needs to check the configuration.';
      case 'network':
      case 'server':
        return 'The AI service is temporarily unavailable. Please retry shortly.';
      default:
        return fallback;
    }
  }
}
