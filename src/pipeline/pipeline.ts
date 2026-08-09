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

import type { ResolvedBotConfig } from '../config/schema.js';
import type { EventBus } from '../core/event.js';
import type { Logger } from '../core/logger.js';
import type { ChatMessage, MohoMessage, OutboundMessage } from '../core/types.js';
import type { AIProvider } from '../ai/types.js';
import { AIError } from '../ai/types.js';
import type { SessionManagerLike } from '../session/types.js';
import type { PluginManager } from '../plugins/manager.js';

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

    let messages: ChatMessage[];
    try {
      await this.#deps.sessions.append(key, { role: 'user', content: prompt, name: message.author.username });
      messages = await this.#deps.sessions.buildContext(key, cfg.systemPrompt);
    } catch (error) {
      log.error(
        { err: error instanceof Error ? error.message : String(error) },
        'session build failed; using bare prompt',
      );
      messages = [
        { role: 'system', content: cfg.systemPrompt },
        { role: 'user', content: prompt },
      ];
    }

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
      // The bot keeps running - the user just gets a friendly notice.
      await this.#reply(message, this.#friendlyError(kind, cfg.ai.fallbackReply));
      return;
    }

    if (this.#deps.plugins) {
      reply = await this.#deps.plugins.runAfterAI(message, reply, cfg.disabledPlugins);
    }

    try {
      const sessions = this.#deps.sessions;
      const assistantTurn = { role: 'assistant' as const, content: reply };
      // completeExchange also feeds the long-term MemoryAdapter. Implementations
      // without one fall back to a plain append.
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
    const reply = async (text: string) => this.#reply(message, text);

    // Built-ins first so a plugin cannot hijack them.
    if (name === 'reset' || name === 'clear') {
      await this.#deps.sessions
        .clear({ botId: cfg.id, channelId: message.channel.id, userId: message.author.id })
        .catch(() => {});
      await reply('Context cleared.');
      return true;
    }
    if (name === 'help') {
      const pluginCommands = this.#deps.plugins ? [...this.#deps.plugins.commands().keys()] : [];
      const lines = [
        '**Built-in commands**',
        '`!help` help / `!reset` clear context / `!status` runtime status',
        pluginCommands.length > 0
          ? `**Plugin commands**\n${pluginCommands.map((c) => `\`!${c}\``).join(' / ')}`
          : '',
      ].filter(Boolean);
      await reply(lines.join('\n'));
      return true;
    }
    if (name === 'status') {
      const s = this.stats();
      await reply(
        `bot: ${cfg.name} / model: ${this.#deps.provider.model} / sessions: ${this.#deps.sessions.size()}\n` +
          `handled ${s.handled} / replied ${s.replied} / ai failures ${s.aiFailures} / rate limited ${s.rateLimited}`,
      );
      return true;
    }

    if (!this.#deps.plugins) return false;
    const known = this.#deps.plugins.commands();
    if (!known.has(name)) return false;

    const result = await this.#deps.plugins.executeCommand(name, { message, args, raw, reply }, cfg.disabledPlugins);
    if (typeof result === 'string' && result.length > 0) await reply(result);
    return true;
  }

  async #reply(message: MohoMessage, content: string): Promise<void> {
    try {
      await this.#deps.send({
        channelId: message.channel.id,
        content,
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
