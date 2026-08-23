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
import type { ChatMessage, EmbedCard, EmbedField, MohoMessage, OutboundMessage } from '../core/types.js';
import type { AIProvider } from '../ai/types.js';
import { AIError } from '../ai/types.js';
import type { SessionManagerLike } from '../session/types.js';
import type { PluginManager } from '../plugins/manager.js';
import { decodeReplyPlan, deliverySegments, planText, type ReplyPlan } from './reply-plan.js';
import { TopicBuffer } from './topic-buffer.js';
import { ChatTraceStore, type ChatTrace } from './chat-trace.js';
import { ProfileReflectionWorker } from '../memory/profile-reflection.js';
import { decideSocially } from './social-decision.js';
import { privacyGate } from './privacy-gate.js';
import { PublicRelationshipStore } from './public-relationships.js';
import { DeviceStore } from '../admin/device.js';
import { WorldStore } from '../admin/world.js';
import { preprocessAttachments } from '../media/attachments.js';
import type { MediaRuntime } from '../media/runtime.js';
import { runtimeMetrics } from '../core/runtime-metrics.js';
import { discordChatLog } from '../core/discord-chat-log.js';
import { chatLogInsert } from '../storage/chatlog.js';
import { effectiveSessionChannelId } from '../session/context-policy.js';

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
  /** Batch-coalescing window override (tests inject a tiny quietMs). */
  topicBuffer?: TopicBuffer;
  typing?: (channelId: string) => Promise<void>;
  /** Omitted unless media is explicitly enabled and has a usable provider. */
  media?: Pick<MediaRuntime, 'process'>;
  traces?: ChatTraceStore;
  /** Root for World/Device state. Defaults to MOHO_ROOT/process cwd for compatibility. */
  stateRoot?: string;
  /** Explicit public-only relation facts; never derived from affinity or DMs. */
  publicRelationships?: PublicRelationshipStore;
  reflection?: Pick<ProfileReflectionWorker, 'reflect'>;
}

export interface PipelineStats {
  handled: number;
  replied: number;
  skipped: number;
  aiFailures: number;
  rateLimited: number;
}

/** Simple sliding-window per-user rate limiter. */
const STREAM_SOFT_LIMIT = 180;
const STREAM_HARD_LIMIT = 480;

/** Buffers model deltas and emits natural sentence-sized Discord messages. */
class StreamingDelivery {
  #buffer = '';
  #sent = 0;
  #tail: Promise<void> = Promise.resolve();

  constructor(private readonly flush: (text: string, first: boolean) => Promise<boolean>) {}

  push(delta: string): void {
    this.#buffer += delta;
    if (this.#shouldFlush()) this.#enqueue(false);
  }

  async finish(): Promise<boolean> {
    this.#enqueue(true);
    await this.#tail;
    return this.#sent > 0;
  }

  get sent(): number { return this.#sent; }
  get received(): boolean { return this.#buffer.length > 0 || this.#sent > 0; }

  #shouldFlush(): boolean {
    if (this.#buffer.length >= STREAM_HARD_LIMIT) return true;
    return this.#buffer.length >= STREAM_SOFT_LIMIT && /[。！？!?…]\s*$/.test(this.#buffer);
  }

  #enqueue(final: boolean): void {
    const text = this.#take(final);
    if (!text) return;
    this.#tail = this.#tail.then(async () => { if (await this.flush(text, this.#sent === 0)) this.#sent += 1; });
  }

  #take(final: boolean): string {
    const value = this.#buffer;
    if (!value.trim()) return '';
    let index = -1;
    if (!final) {
      for (const mark of ['。', '！', '？', '!', '?', '…', '\n']) index = Math.max(index, value.lastIndexOf(mark));
      if (index < 0 && value.length < STREAM_HARD_LIMIT) return '';
      if (index < 0) index = Math.min(STREAM_SOFT_LIMIT, value.length) - 1;
    } else index = value.length - 1;
    const text = value.slice(0, index + 1).trim();
    this.#buffer = value.slice(index + 1);
    return text;
  }
}

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
  readonly #topics: TopicBuffer;
  readonly #traces: ChatTraceStore;
  readonly #device: DeviceStore;
  readonly #world: WorldStore;
  readonly #queues = new Map<string, Promise<void>>();
  /** Live generation per session key; a newer direct summon aborts it (interrupt & merge). */
  readonly #active = new Map<string, AbortController>();
  readonly #recentReplies = new Map<string, number[]>();
  readonly #stats: PipelineStats = { handled: 0, replied: 0, skipped: 0, aiFailures: 0, rateLimited: 0 };

  constructor(deps: PipelineDeps) {
    this.#deps = deps;
    this.#topics = deps.topicBuffer ?? new TopicBuffer();
    this.#logger = deps.logger.child({ component: 'pipeline' });
    this.#traces = deps.traces ?? new ChatTraceStore();
    const root = deps.stateRoot ?? (process.env.MOHO_ROOT || process.cwd());
    this.#device = new DeviceStore(root, deps.config.id);
    this.#world = new WorldStore(root, deps.config.id);
    this.#limiter = new RateLimiter(deps.config.rateLimit.windowMs, deps.config.rateLimit.max);
  }

  stats(): PipelineStats {
    return { ...this.#stats };
  }

  traces(): ChatTrace[] { return this.#traces.list(); }

  #trace(trace: ChatTrace, stage: Parameters<ChatTraceStore['add']>[1], detail?: Parameters<ChatTraceStore['add']>[2]): void {
    this.#traces.add(trace, stage, detail);
    const event = trace.events.at(-1);
    if (event) this.#deps.events.emit('chat:trace', { botId: trace.botId, traceId: trace.id, messageId: trace.messageId, channelId: trace.channelId, userId: trace.userId, event, outcome: trace.outcome });
  }

  /** Admin-only Discord chat log; recorder itself ignores non-discord platforms and never throws. */
  #chatLog(direction: 'in' | 'out', message: MohoMessage, content: string, outcome: 'received' | 'delivered' | 'delivery_failed', traceId?: string): void {
    try {
      discordChatLog.record({ platform: message.platform, direction, botId: message.botId, channelId: message.channel.id, userId: direction === 'in' ? message.author.id : this.#deps.config.id, content, outcome, traceId });
    } catch { /* logging must never break the pipeline */ }
  }

  sweep(): void {
    this.#limiter.sweep();
  }

  stop(): void { this.#topics.clear(); }

  /** Entry point. Messages sharing one session run in arrival order. Never rejects. */
  async handle(message: MohoMessage): Promise<void> {
    const trace = this.#traces.start({ botId: message.botId, messageId: message.id, channelId: message.channel.id, userId: message.author.id });
    this.#chatLog('in', message, message.content, 'received', trace.id);
    this.#trace(trace, 'observed', { mentionsBot: message.mentionsBot, dm: message.channel.dm, length: message.content.length });
    const key = this.#queueKey(message);
    const merged = await this.#topics.push(key, message);
    // Earlier callers share the same merged turn; only the newest invocation
    // owns processing it, so a burst produces one model call and one reply.
    if (merged.id !== message.id) { this.#trace(trace, 'merged', { into: merged.id }); return; }
    message = merged;
    const queueKey = this.#queueKey(message);
    // Interrupt & merge (Hermes-style): a direct DM/@/reply while the bot is
    // A direct @ / reply-to-bot / DM is an explicit invitation; a newer one
    // still answering cancels that generation; the queued new message then
    // runs against a session holding both user turns, so the model naturally
    // folds the follow-up into one fresh answer.
    // Note: quoting some *other* user is NOT a summon - mentionsBot already
    // encodes "@me or reply-to-me" from the adapter layer.
    if (message.mentionsBot || message.channel.dm) {
      const running = this.#active.get(queueKey);
      if (running && !running.signal.aborted) {
        running.abort();
        this.#trace(trace, 'interrupted_previous', { channel: message.channel.id });
        this.#logger.info({ traceId: trace.id, channel: message.channel.id }, 'direct summon interrupted in-flight generation');
      }
    }
    const previous = this.#queues.get(queueKey) ?? Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(async () => {
        try {
          await this.#handleInner(message, trace);
        } catch (error) {
          this.#logger.error(
            { err: error instanceof Error ? error.message : String(error), channel: message.channel.id },
            'pipeline crashed (contained)',
          );
        }
      });
    this.#queues.set(queueKey, current);
    try {
      await current;
    } finally {
      if (this.#queues.get(queueKey) === current) this.#queues.delete(queueKey);
    }
  }

  #recentReplyCount(channelId: string): number {
    const now = Date.now();
    const live = (this.#recentReplies.get(channelId) ?? []).filter((at) => now - at < 90_000);
    if (live.length) this.#recentReplies.set(channelId, live); else this.#recentReplies.delete(channelId);
    return live.length;
  }

  #noteReply(channelId: string): void {
    const now = Date.now();
    const live = (this.#recentReplies.get(channelId) ?? []).filter((at) => now - at < 90_000);
    live.push(now); this.#recentReplies.set(channelId, live);
  }

  #queueKey(message: MohoMessage): string {
    const user = this.#deps.config.session.scope === 'user' ? `:${message.author.id}` : '';
    return `${message.botId}:${effectiveSessionChannelId(this.#deps.config.session, message)}${user}`;
  }

  async #handleInner(message: MohoMessage, trace: ChatTrace): Promise<void> {
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

    // `?` belongs only to the configured administrator bot and allowlisted
    // people. Everybody else sees it as ordinary text and gets no command
    // response, preventing privilege probing in public channels.
    const adminCommand = this.#parseCommand(content, '?');
    if (adminCommand) {
      if (cfg.admin.enabled && message.author.isBotManager === true) {
        const handled = await this.#dispatchAdminCommand(adminCommand.name, adminCommand.args, message);
        if (handled) { this.#stats.replied += 1; return; }
      } else {
        this.#stats.skipped += 1;
        return;
      }
    }

    // Persona bots intentionally have no text command prefix. `!foo` is an
    // ordinary chat message; operational actions live behind authenticated
    // admin UI/Discord interactions, never in public text command parsing.
    const attachments = preprocessAttachments(message.attachments, {
      maxAttachments: cfg.media.maxAttachments,
      maxFileBytes: cfg.media.maxFileBytes,
      maxTotalBytes: cfg.media.maxTotalBytes,
    });
    const prompt = [content.trim(), attachments.accepted.length || attachments.rejected.length ? attachments.context : ''].filter(Boolean).join('\n\n');
    if (prompt.length === 0) {
      this.#stats.skipped += 1;
      return;
    }

    const publicRelation=this.#deps.publicRelationships?.describe(message.content);
    if(publicRelation){
      this.#stats.handled+=1;this.#stats.replied+=1;
      await this.#deps.send({channelId:message.channel.id,content:publicRelation,replyToId:message.id});
      this.#trace(trace,'delivered',{localPublicRelation:true});
      this.#chatLog('out',message,publicRelation,'delivered',trace.id);
      return;
    }
    const gate=privacyGate(message);
    if(gate.action==='refuse'){
      this.#stats.handled+=1;this.#stats.replied+=1;
      await this.#deps.send({channelId:message.channel.id,content:gate.reply,replyToId:message.id});
      this.#trace(trace,'delivered',{localGate:gate.reason});
      this.#chatLog('out',message,gate.reply,'delivered',trace.id);
      return;
    }

    const [device, world] = await Promise.all([this.#device.get(), this.#world.get()]);
    const social = decideSocially(
      { ...message, content: prompt },
      { recentReplies: this.#recentReplyCount(message.channel.id), energy: world.mood.energy ?? 0.65, stress: world.mood.stress ?? 0.2, deviceDelay: this.#device.shouldDelay(device) },
    );
    if (social.action === 'ignore') {
      this.#stats.skipped += 1;
      this.#trace(trace, 'ignored', { reason: social.reason, energy: world.mood.energy ?? 0.65, stress: world.mood.stress ?? 0.2 });
      log.debug({ reason: social.reason, traceId: trace.id }, 'social decision skipped model call');
      return;
    }
    this.#trace(trace, 'context', { socialReason: social.reason, sessionScope: cfg.session.scope });

    if (cfg.rateLimit.enabled && !this.#limiter.allow(`${message.author.id}`)) {
      this.#stats.rateLimited += 1;
      this.#trace(trace, 'ignored', { reason: 'rate limited' });
      log.warn({ traceId: trace.id }, 'rate limited');
      await this.#reply(message, 'Slow down a little - try again in a few seconds.', true, false, trace.id);
      return;
    }

    const key = { botId: cfg.id, channelId: effectiveSessionChannelId(cfg.session, message), userId: message.author.id };

    // Persist the user turn BEFORE building context, so the model sees its
    // own prior replies in the right order (no "echo bot" / repetition bugs).
    try {
      await this.#deps.sessions.append(key, {
        role: 'user',
        content: prompt,
        name: message.author.username,
        sourceMessageId: message.id,
        sourcePlatform: message.platform,
        createdAt: message.createdAt,
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
    let mediaContext: string | undefined;
    if (cfg.media.enabled && this.#deps.media && attachments.accepted.length > 0) {
      try {
        const observed = await this.#deps.media.process(attachments.accepted, content.trim() || undefined);
        if (observed.items.some((item) => item.status === 'observed' || item.status === 'degraded')) mediaContext = observed.context;
      } catch (error) {
        log.warn({ err: error instanceof Error ? error.message : String(error) }, 'media observation failed; using attachment metadata');
      }
    }
    const [anchor, worldContext] = await Promise.all([Promise.resolve(buildContextAnchor()), this.#world.context()]);
    messages = [
      { role: 'system', content: cfg.systemPrompt },
      { role: 'system', content: anchor },
      { role: 'system', content: worldContext },
      ...(mediaContext ? [{ role: 'system' as const, content: mediaContext }] : []),
      ...messages.filter((m) => m.role !== 'system'),
    ];

    if (this.#deps.plugins) {
      await this.#deps.plugins.runBeforeAI(message, messages, cfg.disabledPlugins);
    }

    let reply: string;
    // reply-plan is a control protocol, not chat text. Buffer every upstream
    // delta so an incomplete JSON fence can never be sent to Discord.
    const protocolDeltas: string[] = [];
    const aiStarted = Date.now();
    this.#trace(trace, 'model_started', { model: this.#deps.provider.model, contextMessages: messages.length, stream: cfg.ai.stream, protocol: 'reply-plan' });
    // Typing starts with the upstream request, not after it completes. This
    // keeps direct messages responsive during slow reasoning-model turns.
    const stopThinkingTyping = this.#startThinkingTyping(message.channel.id);
    // Register the live generation so a newer direct summon can abort it.
    const controller = new AbortController();
    this.#active.set(this.#queueKey(message), controller);
    try {
      const response = await this.#deps.provider.chat(messages, {
        temperature: cfg.ai.temperature,
        timeoutMs: cfg.ai.timeoutMs,
        stream: cfg.ai.stream,
        signal: controller.signal,
        onDelta: cfg.ai.stream ? (delta) => { protocolDeltas.push(delta); this.#trace(trace, 'delta', { length: delta.length }); } : undefined,
      });
      reply = response.content.trim() || protocolDeltas.join('').trim();
      stopThinkingTyping();
      runtimeMetrics.ai.record(Date.now() - aiStarted, true);
      this.#trace(trace, 'model_completed', { model: response.model, latencyMs: Date.now() - aiStarted, length: reply.length });
      if (reply.length === 0) reply = cfg.ai.fallbackReply;
    } catch (error) {
      stopThinkingTyping();
      const abortedBySummon = controller.signal.aborted || (error instanceof AIError && error.kind === 'aborted');
      if (this.#active.get(this.#queueKey(message)) === controller) this.#active.delete(this.#queueKey(message));
      if (abortedBySummon) {
        // Superseded by a newer user message: drop silently, deliver nothing,
        // write no memory. The queued follow-up owns the conversation now.
        this.#stats.skipped += 1;
        this.#trace(trace, 'aborted', { reason: 'superseded', latencyMs: Date.now() - aiStarted });
        log.info({ traceId: trace.id }, 'generation superseded; answer dropped');
        return;
      }
      runtimeMetrics.ai.record(Date.now() - aiStarted, false);
      this.#stats.aiFailures += 1;
      const kind = error instanceof AIError ? error.kind : 'unknown';
      const detail = error instanceof Error ? error.message : String(error);
      this.#trace(trace, 'model_failed', { kind, latencyMs: Date.now() - aiStarted });
      log.error({ kind, err: detail, traceId: trace.id }, 'AI request failed; replying with fallback');
      const fallbackDelivered = await this.#reply(message, this.#friendlyError(kind, cfg.ai.fallbackReply), true, false, trace.id);
      this.#trace(trace, fallbackDelivered ? 'delivered' : 'delivery_failed', { fallback: true });
      return;
    } finally {
      stopThinkingTyping();
      if (this.#active.get(this.#queueKey(message)) === controller) this.#active.delete(this.#queueKey(message));
    }
    // The summon may land between model completion and delivery; never let a
    // superseded answer race the fresh turn.
    if (controller.signal.aborted) {
      this.#stats.skipped += 1;
      this.#trace(trace, 'aborted', { reason: 'superseded_pre_delivery' });
      log.info({ traceId: trace.id }, 'answer discarded pre-delivery (superseded)');
      return;
    }

    if (this.#deps.plugins) {
      reply = await this.#deps.plugins.runAfterAI(message, reply, cfg.disabledPlugins);
    }
    const plan = decodeReplyPlan(reply);
    this.#trace(trace, 'plan_parsed', { action: plan.action, style: plan.style, quote: plan.quote, segments: plan.segments.length });
    // A direct @ / reply / DM is an explicit invitation: the model's own
    // "ignore" plan must never silently veto it. Degrade to a plain reply.
    const directSummon = message.mentionsBot || message.channel.dm;
    if (plan.action === 'ignore') {
      this.#stats.skipped += 1;
      this.#trace(trace, 'ignored', { reason: 'model_plan', directSummon });
      log.info({ traceId: trace.id, directSummon }, 'model replied with ignore plan');
      if (!directSummon) return;
      const nudge = '（在呢，刚才没反应过来——想说啥？）';
      plan.action = 'reply';
      plan.segments = [{ text: nudge }];
      log.warn({ traceId: trace.id }, 'direct summon overrode model ignore plan');
    }
    reply = planText(plan);

    const delivered = await this.#replyPlan(message, plan, trace.id);
    if (!delivered) {
      this.#stats.skipped += 1;
      this.#trace(trace, 'delivery_failed', { protocol: 'reply-plan', segments: plan.segments.length });
      return;
    }
    this.#trace(trace, 'delivered', { protocol: 'reply-plan', segments: plan.segments.length });
    this.#noteReply(message.channel.id);
    try {
      const sessions = this.#deps.sessions;
      const assistantTurn = { role: 'assistant' as const, content: reply };
      if (typeof sessions.completeExchange === 'function') {
        await sessions.completeExchange(key, {
          role: 'user', content: prompt, name: message.author.username,
          sourceMessageId: message.id, sourcePlatform: message.platform, createdAt: message.createdAt,
        }, assistantTurn);
      } else {
        await sessions.append(key, assistantTurn);
      }
      this.#trace(trace, 'memory_written');
    } catch (error) {
      this.#trace(trace, 'memory_failed');
      log.warn({ err: error instanceof Error ? error.message : String(error), traceId: trace.id }, 'failed to persist assistant turn');
    }
    this.#stats.replied += 1;
    if (this.#deps.reflection) {
      void this.#deps.reflection.reflect({ botId: cfg.id, channelId: key.channelId, userId: message.author.id, userText: prompt })
        .then(({ facts }) => this.#trace(trace, 'memory_written', { reflectionFacts: facts }))
        .catch(() => this.#trace(trace, 'memory_failed', { reflection: true }));
    }
  }

  #parseCommand(content: string, prefix: '?'): { name: string; args: string[] } | undefined {
    const trimmed = content.trim();
    if (!trimmed.startsWith(prefix) || trimmed.length < 2) return undefined;
    const parts = trimmed.slice(1).split(/\s+/);
    const name = parts[0]?.toLowerCase();
    if (!name) return undefined;
    return { name, args: parts.slice(1) };
  }

  async #dispatchAdminCommand(name: string, args: string[], message: MohoMessage): Promise<boolean> {
    if (name === 'admin-help') {
      await this.#reply(message, '管理指令：`?admin-help` · `?status`。危险操作只能通过本地管理面板二次确认。');
      return true;
    }
    if (name === 'status') {
      const stats = this.stats();
      await this.#reply(message, `管理状态：已处理 ${stats.handled}，已回复 ${stats.replied}，AI 失败 ${stats.aiFailures}，限流 ${stats.rateLimited}`);
      return true;
    }
    // Unknown ? commands are intentionally silent, including for admins.
    return true;
  }

  /* Text command dispatch is deliberately removed for persona bots. Plugin
   * commands remain registered for future authenticated Discord interactions
   * and local admin UI controls, not public `!` messages. */
  async #dispatchCommand(name: string, args: string[], message: MohoMessage, raw: string): Promise<boolean> {
    const cfg = this.#deps.config;
    const reply = async (text: string | EmbedCard): Promise<void> => { await this.#reply(message, text); };

    if (name === 'reset' || name === 'clear') {
      await this.#deps.sessions
        .clear({ botId: cfg.id, channelId: effectiveSessionChannelId(cfg.session, message), userId: message.author.id })
        .catch(() => {});
      await reply({ description: 'Context cleared.', color: EMBED_THEME_COLOR, footer: cfg.name });
      return true;
    }
    if (name === 'help') {
      const pluginCommands = this.#deps.plugins ? [...this.#deps.plugins.commands().keys()] : [];
      const fields: EmbedField[] = [
        { name: '管理入口', value: '请使用已鉴权的 Discord Interaction 或本地 WebUI；角色 Bot 不执行文本命令。', inline: false },
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

  #startThinkingTyping(channelId: string): () => void {
    if (!this.#deps.config.discord.typingIndicator || !this.#deps.typing) return () => {};
    const send = () => void this.#deps.typing!(channelId).catch(() => {});
    send();
    // Discord typing expires after about ten seconds; renew while the model thinks.
    const timer = setInterval(send, 8_000);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  async #replyPlan(message: MohoMessage, plan: ReplyPlan, traceId?: string): Promise<boolean> {
    let delivered = 0;
    const segments = deliverySegments(plan, message.channel.dm);
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i]!;
      if (this.#deps.config.discord.typingIndicator && this.#deps.typing && segment.typingMs > 0) {
        void this.#deps.typing(message.channel.id).catch(() => {});
        await new Promise<void>((resolve) => setTimeout(resolve, segment.typingMs));
      }
      if (await this.#reply(message, segment.text, plan.quote && i === 0, false, traceId)) delivered += 1;
      else break;
      if (segment.pauseAfterMs > 0 && i < segments.length - 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, segment.pauseAfterMs));
      }
    }
    return delivered === segments.length;
  }

  async #reply(message: MohoMessage, content: string | EmbedCard, quote = true, mentionAuthor = false, traceId?: string): Promise<boolean> {
    const embed = typeof content === 'object' ? content : undefined;
    const text = typeof content === 'object' ? '' : content;
    const safeContent = embed && text.length === 0 ? (embed.description ?? '') : text;
    try {
      await this.#deps.send({
        channelId: message.channel.id,
        content: safeContent,
        embed,
        replyToId: !quote || message.channel.dm ? undefined : message.id,
        suppressMentions: true,
        mentionUserId: mentionAuthor ? message.author.id : undefined,
      });
      try {
        chatLogInsert({ channelId: message.channel.id, messageId: `outbound:${message.id}:${Date.now()}`, authorId: this.#deps.config.id, username: this.#deps.config.name, content: safeContent, mentionsBot: false, botId: this.#deps.config.id });
      } catch (error) {
        this.#logger.warn({ err: error instanceof Error ? error.message : String(error), channel: message.channel.id }, 'outbound chat log write failed');
      }
      this.#chatLog('out', message, safeContent, 'delivered', traceId);
      return true;
    } catch (error) {
      this.#chatLog('out', message, safeContent, 'delivery_failed', traceId);
      this.#logger.error(
        { err: error instanceof Error ? error.message : String(error), channel: message.channel.id },
        'send failed',
      );
      return false;
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
