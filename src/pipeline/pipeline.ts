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
import type { AbEvaluationOutcome, AbSide, AbVote, PersonaAbRecord, PersonaAbStats, PersonaSnapshot, AbEvaluateOptions } from './persona-ab.js';
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
import { ContextArchiver, type ContextEntry } from '../context-archiver/index.js';
import { BanError, BanStore, formatDuration, looksLikeDuration, parseDuration } from './ban-store.js';
import { RepeatGuard } from './repeat-guard.js';

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

/** Wrap a rolling summary so the model reads it as memory, not as a speaker. */
export function buildHistorySummaryBlock(summary: string): string {
  return [
    '[历史对话摘要 - 系统注入，非用户发言]',
    '以下是更早之前对话的压缩记忆，其后的消息才是最近的原始对话。请把它当作已知背景自然地衔接，不要逐字复述，也不要把它当成用户刚说的话。',
    summary.trim(),
  ].join('\n');
}

/** Chinese aliases for `?` admin commands; handlers use the English keys. */
export const ADMIN_COMMAND_ALIASES: Record<string, string> = {
  '好感度': 'favor',
  '关系阶段': 'stage',
  '好感排行': 'favor-rank',
  '设好感': 'set-favor',
  '设亲密': 'set-intimacy',
  '用量': 'usage',
  '广播': 'broadcast',
  '广播预告': 'broadcast',
  '广播确认': 'broadcast-confirm',
  '广播取消': 'broadcast-cancel',
  '同步歌曲': 'songsync',
};

/** Normalizes a `?ab` vote token; returns null for anything that is not a vote. */
export function normalizeAbVote(token: string): AbVote | null {  const text = token.trim();
  if (text === 'A' || text === 'a') return 'A';
  if (text === 'B' || text === 'b') return 'B';
  if (text === '平局' || text === '都不好' || text === '跳过') return text;
  return null;
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
  /** Context archiver for JSONL session persistence. */
  contextArchiver?: ContextArchiver;
  /** Runtime ban list; banned users are silently ignored before any processing. */
  bans?: BanStore;
  /** Token accounting reader for `?用量`. Omitted = feature off. */
  usage?: UsageBridge;
  /** Two-step guild broadcast for `?广播*`. Omitted = feature off. */
  broadcast?: BroadcastBridge;
  /** Song recognition + library sync for `?同步歌曲`. Omitted = feature off. */
  songs?: SongBridge;
  /**
   * Relationship tracking. The block is injected before the model call and the
   * turn is scheduled after delivery; omitted (or disabled) = feature off.
   */
  emotion?: EmotionBridge;
  /**
   * Persona A/B evaluation (prompt beta testing). DMs only; omitted (or
   * disabled) = feature off.
   */
  personaAb?: PersonaAbBridge;
}

/** The slice of the usage recorder the pipeline needs. */
export interface UsageBridge {
  report(days: number): Promise<string>;
}

/** The slice of the song library the pipeline needs. */
export interface SongBridge {
  /** Returns the 【歌曲信息】 block for chat text, or undefined. Never throws. */
  match(text: string): Promise<string | undefined>;
  status(): Promise<{ songs: number; updatedAt: number; syncing: boolean }>;
  /** Starts a background sync; completion is reported to the channel. */
  startSync(channelId: string): Promise<{ accepted: boolean; message: string }>;
}

/**
 * The slice of the broadcast manager the pipeline needs.
 */
export interface BroadcastBridge {
  preview(content: string, authorId: string): Promise<string>;
  confirm(): Promise<string>;
  cancel(): Promise<string>;
}

/** The slice of the emotion manager the pipeline needs. */
export interface EmotionBridge {
  buildContextBlock(userKey: string): Promise<string>;
  scheduleTurn(userKey: string, userText: string, aiReply: string): void;
  /** Read-only snapshot for `?好感度` / `?关系阶段`. */
  getSnapshot(userKey: string): Promise<{
    userKey: string; favor: number; intimacy: number; stageName: string; stageDescription: string;
    compositeScore: number; progressToNext: number; nextStageName: string; nextStageThreshold: number | null;
    dominantMood: string; attitude: string; relationship: string;
    interactions: { total: number; positive: number; negative: number; positiveRatio: number };
    advice: string;
  }>;
  /** Leaderboard rows for `?好感排行`. */
  ranking(limit: number, direction: 'top' | 'bottom'): Promise<Array<{ userKey: string; averageScore: number; favor: number; intimacy: number; stage: string }>>;
  setFavor(userKey: string, value: number): void;
  setIntimacy(userKey: string, value: number): void;
}

/**
 * The slice of the persona A/B service the pipeline needs. The concrete
 * PersonaAbService satisfies this structurally; tests inject fakes.
 */
export interface PersonaAbBridge {
  reserve(input: {
    userId: string;
    sourceMessageId: string;
    contextSide: AbSide;
    baseline: PersonaSnapshot;
    test: PersonaSnapshot;
  }): Promise<PersonaAbRecord | null>;
  evaluate(
    record: PersonaAbRecord,
    generate: (personaContent: string) => Promise<string>,
    opts?: AbEvaluateOptions,
  ): Promise<AbEvaluationOutcome>;
  snapshot(side: AbSide, fallbackContent: string, fallbackLabel: string): Promise<PersonaSnapshot>;
  preference(userId: string): Promise<AbSide | null>;
  loadVotable(userId: string, identifier?: string): Promise<PersonaAbRecord | null>;
  vote(userId: string, identifier: string | undefined, choice: AbVote): Promise<PersonaAbRecord>;
  switchPersona(userId: string, identifier: string, choice: 'A' | 'B'): Promise<PersonaAbRecord>;
  stats(): Promise<PersonaAbStats>;
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
  readonly #archiver?: ContextArchiver;
  readonly #repeats: RepeatGuard;
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
    this.#archiver = deps.contextArchiver;
    this.#repeats = new RepeatGuard({ maxRepeats: deps.config.repeatGuard.maxRepeats, windowMs: deps.config.repeatGuard.windowMs });
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
    // Banned users never reach the topic buffer, so their text cannot leak into
    // a merged turn that also carries someone else's message.
    if (await this.#isBanned(message, trace)) return;
    if (this.#isNoise(message, trace)) return;
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
    if (!message.author.bot && (message.mentionsBot || message.channel.dm)) {
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

  /** Administrators are never subject to bans, so a mistaken ban cannot lock out the operator. */
  async #isBanned(message: MohoMessage, trace: ChatTrace): Promise<boolean> {
    const bans = this.#deps.bans;
    if (!bans || message.author.isBotManager === true) return false;
    await bans.ready();
    const ban = bans.check(message.author.id, message.channel.id);
    if (!ban) return false;
    this.#stats.skipped += 1;
    this.#trace(trace, 'ignored', { reason: 'banned', scope: ban.channelId ? 'channel' : 'global' });
    this.#logger.debug({ traceId: trace.id, user: message.author.id, scope: ban.channelId ? 'channel' : 'global' }, 'banned user ignored');
    return true;
  }

  /** Auto-replies and stuck repeats are dropped silently; administrators are exempt. */
  #isNoise(message: MohoMessage, trace: ChatTrace): boolean {
    const cfg = this.#deps.config.repeatGuard;
    if (!cfg.enabled || message.author.isBotManager === true) return false;
    // Deliberate operations are never noise: admin `?` commands, and content a
    // plugin declares it handles (divination keywords, meme triggers, links).
    // The guard exists for runaway clients and bot echo loops, not for a user
    // pressing a working button three times.
    const text = message.content.trim();
    if (text.startsWith('?')) return false;
    if (this.#deps.plugins?.isTriggerContent(text, this.#deps.config.disabledPlugins ?? [])) return false;
    const reason = this.#repeats.inspect(`${message.botId}:${message.channel.id}:${message.author.id}`, message.content);
    if (!reason) return false;
    this.#stats.skipped += 1;
    this.#trace(trace, 'ignored', { reason });
    this.#logger.debug({ traceId: trace.id, user: message.author.id, reason }, 'noise message ignored');
    return true;
  }

  async #adminBanCommand(name: 'ban' | 'unban' | 'banlist', rawArgs: string[], message: MohoMessage): Promise<void> {
    const bans = this.#deps.bans;
    if (!bans) { await this.#reply(message, '封禁功能不可用：当前运行时没有配置存储。'); return; }
    await bans.ready();
    const here = rawArgs.some((a) => a.toLowerCase() === '--here');
    const args = rawArgs.filter((a) => a.toLowerCase() !== '--here');
    const scopeChannel = here ? message.channel.id : undefined;
    try {
      if (name === 'banlist') {
        const rows = bans.list();
        if (rows.length === 0) { await this.#reply(message, '当前没有生效的封禁。'); return; }
        const now = Date.now();
        const lines = rows.slice(0, 20).map((r) => {
          const left = r.expiresAt === undefined ? '永久' : `剩余 ${formatDuration(r.expiresAt - now)}`;
          return `· ${r.userId} · ${r.channelId ? `频道 ${r.channelId}` : '全局'} · ${left}${r.reason ? ` · ${r.reason}` : ''}`;
        });
        await this.#reply(message, `生效中的封禁（${rows.length}）：\n${lines.join('\n')}${rows.length > 20 ? '\n…（仅显示前 20 条）' : ''}`);
        return;
      }
      if (!args[0]) {
        await this.#reply(message, name === 'ban'
          ? '用法：`?ban <用户ID或@> [时长如 30m/2h/1d2h] [原因]`，加 `--here` 仅封本频道；不写时长为永久。'
          : '用法：`?unban <用户ID或@>`，加 `--here` 仅解除本频道的封禁。');
        return;
      }
      if (name === 'unban') {
        const removed = await bans.unban(args[0], scopeChannel);
        await this.#reply(message, removed ? '已解除封禁。' : '该用户在此范围内没有生效的封禁。');
        this.#logger.info({ by: message.author.id, target: args[0], scope: here ? 'channel' : 'global' }, 'admin unban');
        return;
      }
      const target = args[0];
      const durationMs = args[1] && looksLikeDuration(args[1]) ? parseDuration(args[1]) : undefined;
      const reason = args.slice(durationMs === undefined ? 1 : 2).join(' ');
      const bare = target.replace(/^<@!?|>$/g, '');
      if (bare === message.author.id) { await this.#reply(message, '不能封禁自己。'); return; }
      if (this.#deps.config.admin.userIds.includes(bare)) { await this.#reply(message, '不能封禁已配置的管理员。'); return; }
      const record = await bans.ban({ userId: target, channelId: scopeChannel, durationMs, reason, by: message.author.id });
      await this.#reply(message, `已封禁 ${record.userId}（${here ? '本频道' : '全局'}，${record.expiresAt === undefined ? '永久' : `持续 ${formatDuration(record.expiresAt - record.createdAt)}`}）。`);
      this.#logger.info({ by: message.author.id, target: record.userId, scope: here ? 'channel' : 'global', permanent: record.expiresAt === undefined }, 'admin ban');
    } catch (error) {
      if (error instanceof BanError) { await this.#reply(message, `操作失败：${error.message}`); return; }
      throw error;
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
    // Exception: `?ab` voting belongs to the evaluated user themselves (DMs),
    // plus admins for stats - it is a participation flow, not administration.
    const adminCommand = this.#parseCommand(content, '?');
    if (adminCommand) {
      if (adminCommand.name === 'ab' && this.#deps.personaAb
        && (message.channel.dm || (cfg.admin.enabled && message.author.isBotManager === true))) {
        await this.#dispatchAbCommand(adminCommand.args, message);
        this.#stats.replied += 1;
        return;
      }
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
    const baseContent = content.trim();
    // A whitelisted peer RP bot (e.g. 天依) interjected: label the speaker so
    // the model treats the line as another character's banter, not a human's.
    const speakerTag = message.author.bot && message.author.displayName ? `（另一个RP角色 ${message.author.displayName} 插嘴）` : message.author.bot ? '（另一个RP角色插嘴）' : '';
    const prompt = [speakerTag + baseContent, attachments.accepted.length || attachments.rejected.length ? attachments.context : ''].filter(Boolean).join('\n\n');
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
      {
        recentReplies: this.#recentReplyCount(message.channel.id),
        energy: world.mood.energy ?? 0.65,
        stress: world.mood.stress ?? 0.2,
        deviceDelay: this.#device.shouldDelay(device),
        proactiveParticipation: cfg.social.proactiveParticipation,
        proactiveChance: cfg.social.proactiveChance,
      },
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
    // Live time anchor, character world state and the user's relationship state
    // are all separate system blocks: the persona prompt stays untouched.
    const [anchor, worldContext] = await Promise.all([Promise.resolve(buildContextAnchor()), this.#world.context()]);
    // Relationship state for this user. Never fatal: a broken store must not
    // cost the reply, it only means the bot forgets how it feels about them.
    let emotionBlock: string | undefined;
    if (this.#deps.emotion) {
      try {
        emotionBlock = await this.#deps.emotion.buildContextBlock(message.author.id);
      } catch (error) {
        log.warn({ err: error instanceof Error ? error.message : String(error), user: message.author.id }, 'emotion block build failed; continuing without it');
      }
    }
    // Song recognition: titles and lyric fragments in the user's text resolve
    // to a 【歌曲信息】 block (intro + credits + lyrics), request-scoped only.
    let songBlock: string | undefined;
    if (this.#deps.songs) {
      try {
        songBlock = await this.#deps.songs.match(prompt);
      } catch (error) {
        log.warn({ err: error instanceof Error ? error.message : String(error) }, 'song match failed; continuing without it');
      }
    }
    // Older turns that were compacted out of the live window. Optional on the
    // session contract, and a lookup failure must never cost the reply.
    let historySummary: string | undefined;
    try {
      historySummary = await this.#deps.sessions.getSummary?.(key);
    } catch (error) {
      log.warn({ err: error instanceof Error ? error.message : String(error) }, 'history summary lookup failed; continuing without it');
    }
    // A/B switch binding: when this DM user picked the challenger persona, the
    // normal chat keeps using it until they switch again. Never fatal: a broken
    // lookup falls back to the live persona.
    let personaText = cfg.systemPrompt;
    if (this.#deps.personaAb && message.channel.dm && !message.author.bot) {
      try {
        if ((await this.#deps.personaAb.preference(message.author.id)) === 'test') {
          personaText = (await this.#deps.personaAb.snapshot('test', cfg.systemPrompt, cfg.name)).content;
        }
      } catch (error) {
        log.warn({ err: error instanceof Error ? error.message : String(error), user: message.author.id }, 'persona-ab preference lookup failed; using live persona');
        personaText = cfg.systemPrompt;
      }
    }
    messages = [
      { role: 'system', content: personaText },
      { role: 'system', content: anchor },
      { role: 'system', content: worldContext },
      ...(historySummary ? [{ role: 'system' as const, content: buildHistorySummaryBlock(historySummary) }] : []),
      ...(mediaContext ? [{ role: 'system' as const, content: mediaContext }] : []),
      ...(emotionBlock ? [{ role: 'system' as const, content: emotionBlock }] : []),
      ...(songBlock ? [{ role: 'system' as const, content: songBlock }] : []),
      ...messages.filter((m) => m.role !== 'system'),
    ];

    if (this.#deps.plugins) {
      await this.#deps.plugins.runBeforeAI(message, messages, cfg.disabledPlugins);
    }

    let reply: string;
    // Register the live generation so a newer direct summon can abort it.
    // The normal call and the A/B evaluation below share this controller.
    const controller = new AbortController();
    this.#active.set(this.#queueKey(message), controller);
    const releaseController = (): void => {
      if (this.#active.get(this.#queueKey(message)) === controller) this.#active.delete(this.#queueKey(message));
    };
    // Typing starts with the upstream request, not after it completes. This
    // keeps direct messages responsive during slow reasoning-model turns.
    const stopThinkingTyping = this.#startThinkingTyping(message.channel.id);
    const aiStarted = Date.now();
    // Persona A/B evaluation (DMs only): occasionally answer this turn twice -
    // once per persona, same input and parameters - and show both for a vote.
    // The chat reply keeps the persona this user would normally get, so the
    // evaluation never disturbs the ongoing conversation.
    const abOutcome = await this.#maybeRunAbEvaluation(message, messages, personaText, cfg, trace, controller);
    if (abOutcome && abOutcome.reply.length > 0) {
      stopThinkingTyping();
      releaseController();
      if (abOutcome.aborted || controller.signal.aborted) {
        this.#stats.skipped += 1;
        this.#trace(trace, 'aborted', { reason: 'superseded', latencyMs: Date.now() - aiStarted });
        log.info({ traceId: trace.id }, 'persona-ab evaluation superseded; answer dropped');
        return;
      }
      reply = abOutcome.reply;
      runtimeMetrics.ai.record(Date.now() - aiStarted, true);
      this.#trace(trace, 'model_completed', { model: this.#deps.provider.model, latencyMs: Date.now() - aiStarted, length: reply.length, protocol: 'persona-ab' });
    } else {
    // reply-plan is a control protocol, not chat text. Buffer every upstream
    // delta so an incomplete JSON fence can never be sent to Discord.
    const protocolDeltas: string[] = [];
    this.#trace(trace, 'model_started', { model: this.#deps.provider.model, contextMessages: messages.length, stream: cfg.ai.stream, protocol: 'reply-plan' });
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
    } // end else: normal single model call (abOutcome was null or failed over)
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
    const directSummon = !message.author.bot && (message.mentionsBot || message.channel.dm);
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
    this.#noteReply(message.channel.id);    this.#archiveContext(message, prompt, reply, trace.id);
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
    if (this.#deps.emotion) {
      // Fire-and-forget like reflection: the relationship update must never
      // delay or block the reply that already landed.
      try {
        this.#deps.emotion.scheduleTurn(message.author.id, prompt, reply);
        this.#trace(trace, 'memory_written', { emotion: true });
      } catch (error) {
        this.#trace(trace, 'memory_failed', { emotion: true });
        log.warn({ err: error instanceof Error ? error.message : String(error), traceId: trace.id }, 'emotion turn scheduling failed');
      }
    }
    this.#stats.replied += 1;
    if (this.#deps.reflection) {
      void this.#deps.reflection.reflect({ botId: cfg.id, channelId: key.channelId, userId: message.author.id, userText: prompt })
        .then(({ facts }) => this.#trace(trace, 'memory_written', { reflectionFacts: facts }))
        .catch(() => this.#trace(trace, 'memory_failed', { reflection: true }));
    }
  }

  /**
   * Append user turn and assistant reply to the JSONL context archive.
   */
  #archiveContext(message: MohoMessage, userPrompt: string, assistantReply: string, traceId?: string): void {
    if (!this.#archiver) return;
    const botId = message.botId || this.#deps.config.id;
    const channelId = message.channel.id;

    // User turn
    const userEntry: ContextEntry = {
      role: 'user',
      content: userPrompt,
      timestamp: message.createdAt ?? Date.now(),
      senderId: message.author.id,
      senderName: message.author.username,
    };
    void this.#archiver.append(botId, channelId, userEntry).catch(() => {});

    // Assistant reply
    const assistantEntry: ContextEntry = {
      role: 'assistant',
      content: assistantReply,
      timestamp: Date.now(),
    };
    void this.#archiver.append(botId, channelId, assistantEntry).catch(() => {});
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
    // Chinese aliases documented in README/admin-help; the handlers below use
    // stable English keys.
    const canonical = ADMIN_COMMAND_ALIASES[name] ?? name;
    if (canonical === 'admin-help') {
      await this.#reply(message, '管理指令：`?admin-help` · `?status` · `?ban` · `?unban` · `?banlist` · `?好感度` · `?关系阶段` · `?好感排行` · `?设好感` · `?用量` · `?广播` · `?ab stats`。危险操作只能通过本地管理面板二次确认。');
      return true;
    }
    if (canonical === 'ban' || canonical === 'unban' || canonical === 'banlist') {
      await this.#adminBanCommand(canonical, args, message);
      return true;
    }
    if (canonical === 'favor' || canonical === 'stage' || canonical === 'favor-rank' || canonical === 'set-favor' || canonical === 'set-intimacy') {
      await this.#emotionCommand(canonical, args, message);
      return true;
    }
    if (canonical === 'usage') {
      await this.#usageCommand(args, message);
      return true;
    }
    if (canonical === 'broadcast' || canonical === 'broadcast-confirm' || canonical === 'broadcast-cancel') {
      await this.#broadcastCommand(canonical, args, message);
      return true;
    }
    if (canonical === 'songsync') {
      await this.#songSyncCommand(message);
      return true;
    }
    if (canonical === 'status') {
      const stats = this.stats();
      await this.#reply(message, `管理状态：已处理 ${stats.handled}，已回复 ${stats.replied}，AI 失败 ${stats.aiFailures}，限流 ${stats.rateLimited}`);
      return true;
    }
    // Unknown ? commands are intentionally silent, including for admins.
    return true;
  }

  /** `?用量 [天数]` - token accounting. */
  async #usageCommand(args: string[], message: MohoMessage): Promise<void> {
    const usage = this.#deps.usage;
    if (!usage) {
      await this.#reply(message, '用量统计未启用（需要持久化存储）。');
      return;
    }
    const days = Number.parseInt(args[0] ?? '', 10);
    const report = await usage.report(Number.isFinite(days) && days > 0 ? days : 1).catch(() => null);
    await this.#reply(message, report ?? '用量统计读取失败。');
  }

  /** `?广播 <内容>` / `?广播确认` / `?广播取消` - two-step guild broadcast. */
  async #broadcastCommand(name: string, args: string[], message: MohoMessage): Promise<void> {
    const broadcast = this.#deps.broadcast;
    if (!broadcast) {
      await this.#reply(message, '广播未启用。');
      return;
    }
    if (name === 'broadcast-confirm') {
      await this.#reply(message, await broadcast.confirm().catch((error) => `广播失败：${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    if (name === 'broadcast-cancel') {
      await this.#reply(message, await broadcast.cancel().catch(() => '取消失败。'));
      return;
    }
    const content = args.join(' ').trim();
    if (!content) {
      await this.#reply(message, '用法：`?广播 <内容>` 预览，`?广播确认` 发送，`?广播取消` 撤销。');
      return;
    }
    await this.#reply(message, await broadcast.preview(content, message.author.id).catch((error) => `预告失败：${error instanceof Error ? error.message : String(error)}`));
  }

  /** `?同步歌曲` - starts a background VCPedia sync with completion notice. */
  async #songSyncCommand(message: MohoMessage): Promise<void> {
    const songs = this.#deps.songs;
    if (!songs) {
      await this.#reply(message, '歌曲库未启用（bot 配置 `songs.enabled` 为 false）。');
      return;
    }
    const started = await songs.startSync(message.channel.id).catch(() => null);
    await this.#reply(message, started ? started.message : '同步启动失败。');
  }

  /** `?好感度` / `?关系阶段` / `?好感排行` - read-only relationship state. */
  async #emotionCommand(name: string, args: string[], message: MohoMessage): Promise<void> {
    const emotion = this.#deps.emotion;
    if (!emotion) {
      await this.#reply(message, '情感系统未启用（bot 配置 `emotion.enabled` 为 false）。');
      return;
    }
    if (name === 'set-favor' || name === 'set-intimacy') {
      const target = args[0]?.trim();
      const value = Number.parseInt(args[1] ?? '', 10);
      if (!target || !Number.isFinite(value)) {
        await this.#reply(message, name === 'set-favor' ? '用法：`?设好感 <用户ID> <数值 -100~100>`' : '用法：`?设亲密 <用户ID> <数值 0~100>`');
        return;
      }
      if (name === 'set-favor') emotion.setFavor(target, value);
      else emotion.setIntimacy(target, value);
      const snapshot = await emotion.getSnapshot(target);
      await this.#reply(message, `已更新 ${target}：好感 ${snapshot.favor} / 亲密 ${snapshot.intimacy}（${snapshot.stageName}）`);
      return;
    }
    if (name === 'favor-rank') {
      const limit = Number.parseInt(args[0] ?? '', 10);
      const rows = await emotion.ranking(Number.isFinite(limit) && limit > 0 ? limit : 10, 'top');
      if (rows.length === 0) {
        await this.#reply(message, '暂无好感度数据。');
        return;
      }
      const lines = rows.map((row, index) => `${index + 1}. ${row.userKey} — 好感 ${row.favor} / 亲密 ${row.intimacy}（综合 ${row.averageScore.toFixed(1)}，${row.stage}）`);
      await this.#reply(message, ['好感度排行', ...lines].join('\n'));
      return;
    }
    // Bare `?好感度` / `?关系阶段` read the caller's own state.
    const target = args[0]?.trim() || message.author.id;
    const snapshot = await emotion.getSnapshot(target);
    if (name === 'stage') {
      await this.#reply(message, [
        `关系阶段：${snapshot.stageName} — ${snapshot.stageDescription}`,
        `复合评分：${snapshot.compositeScore.toFixed(1)}${snapshot.nextStageThreshold ? `（下一阶段「${snapshot.nextStageName}」阈值 ${snapshot.nextStageThreshold}，进度 ${snapshot.progressToNext.toFixed(0)}%）` : '（已达最高阶段）'}`,
        snapshot.advice,
      ].join('\n'));
      return;
    }
    await this.#reply(message, [
      '💗 好感度',
      `好感度：${snapshot.favor}｜亲密度：${snapshot.intimacy}`,
      `关系阶段：${snapshot.stageName}（进度 ${snapshot.progressToNext.toFixed(0)}%）`,
      `主导情感：${snapshot.dominantMood}`,
      `态度倾向：${snapshot.attitude}｜关系描述：${snapshot.relationship}`,
      `互动：${snapshot.interactions.total} 次（正面 ${snapshot.interactions.positive} / 负面 ${snapshot.interactions.negative}）`,
    ].join('\n'));
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

  /**
   * Persona A/B evaluation for one DM turn. Returns null when no evaluation
   * was reserved (normal single call proceeds), otherwise the evaluated reply.
   * An empty reply means the evaluation failed over: the caller falls through
   * to the normal call so the user still gets an answer.
   */
  async #maybeRunAbEvaluation(
    message: MohoMessage,
    messages: ChatMessage[],
    personaText: string,
    cfg: ResolvedBotConfig,
    trace: ChatTrace,
    controller: AbortController,
  ): Promise<{ reply: string; aborted: boolean } | null> {
    const ab = this.#deps.personaAb;
    if (!ab || !message.channel.dm || message.author.bot) return null;
    const log = this.#logger.child({ component: 'pipeline', traceId: trace.id });
    let baseline: PersonaSnapshot;
    let test: PersonaSnapshot;
    let preference: AbSide | null;
    try {
      [preference, baseline, test] = await Promise.all([
        ab.preference(message.author.id),
        ab.snapshot('baseline', cfg.systemPrompt, cfg.name),
        ab.snapshot('test', cfg.systemPrompt, cfg.name),
      ]);
    } catch (error) {
      log.warn({ err: error instanceof Error ? error.message : String(error), user: message.author.id }, 'persona-ab snapshot failed; answering normally');
      return null;
    }
    let record: PersonaAbRecord | null;
    try {
      record = await ab.reserve({
        userId: message.author.id,
        sourceMessageId: message.id,
        contextSide: preference ?? 'baseline',
        baseline,
        test,
      });
    } catch (error) {
      log.warn({ err: error instanceof Error ? error.message : String(error), user: message.author.id }, 'persona-ab reserve failed; answering normally');
      return null;
    }
    if (!record) return null;
    this.#trace(trace, 'model_started', { model: this.#deps.provider.model, contextMessages: messages.length, stream: false, protocol: 'persona-ab' });

    // Both candidates share the prepared input; only the persona block changes.
    const at = messages.findIndex((m) => m.role === 'system' && m.content === personaText);
    const personaIndex = at >= 0 ? at : 0;
    const generate = async (personaContent: string): Promise<string> => {
      const variant = messages.map((m, i) => (i === personaIndex ? { ...m, content: personaContent } : m));
      const response = await this.#deps.provider.chat(variant, {
        task: 'ab',
        temperature: cfg.ai.temperature,
        timeoutMs: cfg.ai.timeoutMs,
        stream: false,
        signal: controller.signal,
      });
      return response.content.trim();
    };
    // The card bypasses reply-plan parsing: it is status UI, not chat text.
    const send = async (content: string): Promise<boolean> => {
      try {
        await this.#deps.send({ channelId: message.channel.id, content, suppressMentions: true });
        return true;
      } catch {
        return false;
      }
    };
    try {
      return await ab.evaluate(record, generate, { send, shouldAbort: () => controller.signal.aborted });
    } catch (error) {
      log.warn({ err: error instanceof Error ? error.message : String(error), user: message.author.id }, 'persona-ab evaluation crashed; answering normally');
      return { reply: '', aborted: controller.signal.aborted };
    }
  }

  /** `?ab` voting and stats. Votes are owner-only; stats are admin-only. */
  async #dispatchAbCommand(args: string[], message: MohoMessage): Promise<void> {
    const cfg = this.#deps.config;
    const ab = this.#deps.personaAb;
    if (!ab || !cfg.personaAb.enabled) {
      await this.#reply(message, '人设对比评估未启用。');
      return;
    }
    const [subRaw, ...rest] = args;
    const sub = (subRaw ?? '').trim();
    const isAdmin = cfg.admin.enabled && message.author.isBotManager === true;

    if (sub === '' || sub === '状态') {
      const pending = await ab.loadVotable(message.author.id).catch(() => null);
      if (!pending) {
        await this.#reply(message, '当前没有待投票的人设对比。私聊中偶尔会触发一次对比评估，届时我会展示 A / B 两版回复。');
        return;
      }
      await this.#reply(message, [
        `🧪 待投票的人设对比（编号 ${pending.id}）`,
        `将在 <t:${Math.floor(pending.expiresAt / 1000)}:R> 过期`,
        '`?ab A` / `?ab B` / `?ab 平局` / `?ab 都不好` / `?ab 跳过`',
      ].join('\n'));
      return;
    }

    if (sub === 'stats' || sub === '统计') {
      if (!isAdmin) {
        await this.#reply(message, '该命令仅管理员可用。');
        return;
      }
      const stats = await ab.stats().catch(() => null);
      if (!stats) {
        await this.#reply(message, '统计读取失败。');
        return;
      }
      await this.#reply(message, [
        '🧪 人设对比统计',
        `展示：${stats.shown}｜投票：${stats.votes}（回应率 ${(stats.responseRate * 100).toFixed(1)}%）`,
        `基准胜：${stats.baselineWins}｜挑战胜：${stats.testWins}｜平局：${stats.ties}｜都不喜欢：${stats.bothBad}｜跳过：${stats.skipped}`,
        `过期：${stats.expired}｜失败：${stats.failed}`,
        stats.notice,
      ].join('\n'));
      return;
    }

    const voteChoice = normalizeAbVote(sub);
    if (voteChoice && rest.length === 0) {
      if (!message.channel.dm) {
        await this.#reply(message, '投票请在与我的私聊里进行（评估只发生在私聊）。');
        return;
      }
      try {
        const record = await ab.vote(message.author.id, undefined, voteChoice);
        await this.#reply(message, [
          `已记录投票：${record.vote}（重复提交不改票）。未切换人设，历史不变。`,
          `如需切换：\`?ab switch ${record.id} A\`（或 B）`,
        ].join('\n'));
      } catch {
        await this.#reply(message, '没有可投票的评估（可能已过期或尚未完整展示）。用 `?ab` 查看状态。');
      }
      return;
    }

    if ((sub === 'vote' || sub === '投票') && rest.length >= 2) {
      if (!message.channel.dm) {
        await this.#reply(message, '投票请在与我的私聊里进行（评估只发生在私聊）。');
        return;
      }
      const choice = normalizeAbVote(rest[1] ?? '');
      if (!choice) {
        await this.#reply(message, '用法：`?ab vote <编号> A`（A / B / 平局 / 都不好 / 跳过）。');
        return;
      }
      try {
        const record = await ab.vote(message.author.id, rest[0], choice);
        await this.#reply(message, `已记录投票：${record.vote}（重复提交不改票）。未切换人设，历史不变。`);
      } catch {
        await this.#reply(message, '投票失败：评估不存在、未完整展示或已过期（仅限本人私聊记录）。');
      }
      return;
    }

    if ((sub === 'switch' || sub === '切换') && rest.length >= 2) {
      if (!message.channel.dm) {
        await this.#reply(message, '切换请在与我的私聊里进行。');
        return;
      }
      const side = (rest[1] ?? '').toUpperCase();
      if (side !== 'A' && side !== 'B') {
        await this.#reply(message, '用法：`?ab switch <编号> A`（或 B）。');
        return;
      }
      try {
        const record = await ab.switchPersona(message.author.id, rest[0]!, side);
        const label = record.personas[record.switch!.side]!.label;
        await this.#reply(message, `已将你的人设偏好切换到 ${side}（${label}），聊天记录保留。之后在这个私聊里的对话都会用它，直到你再切换。`);
      } catch {
        await this.#reply(message, '切换失败：评估不存在、未投票或已过期。');
      }
      return;
    }

    await this.#reply(message, '用法：`?ab`（查看待投票）· `?ab A/B/平局/都不好/跳过`（投票）· `?ab switch <编号> A`（切换人设）· `?ab stats`（管理员统计）。');
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
    // User-facing, in Chinese, and clearly a system aside (brackets) rather
    // than the character speaking - a failure notice must never masquerade as
    // roleplay. Keep each to one line: it shares the channel with real chat.
    switch (kind) {
      case 'timeout':
        return '（刚才那句想得太久超时了，再发一次试试？）';
      case 'rate_limit':
        return '（对面限流了，歇个几秒再找我吧）';
      case 'auth':
        return '（我的模型钥匙好像失效了，叫管理员看一眼配置吧）';
      case 'network':
      case 'server':
        return '（AI 服务刚才没连上，过会儿再试一次吧）';
      default:
        return fallback;
    }
  }
}
