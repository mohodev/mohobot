/**
 * Short-term conversation memory.
 *
 * The in-process Map is the source of truth during a run; storage is a
 * best-effort mirror so a restart keeps context. Storage failures are logged
 * and swallowed - a broken database must never stop the bot from replying.
 */

import type { SessionConfig } from '../config/schema.js';
import type { Logger } from '../core/logger.js';
import type { ChatMessage } from '../core/types.js';
import { nullMemoryAdapter, type MemoryAdapter, type PersistedSession, type Storage } from '../storage/types.js';
import type {
  Session, SessionKeyInput, SessionManagerLike, SourceMessageMutation, SourceMessageUpdate,
} from './types.js';
import { decodePersistedSession } from './codec.js';

/**
 * Folds old turns into a rolling summary. Returning undefined/empty (or
 * throwing) means "could not summarize": the manager keeps the data and the
 * hard trim stays the fallback.
 */
export type Summarizer = (input: {
  previousSummary?: string;
  messages: ChatMessage[];
  maxChars: number;
}) => Promise<string | undefined>;

export interface SessionManagerOptions {
  botId: string;
  config: SessionConfig;
  storage?: Storage;
  logger: Logger;
  memory?: MemoryAdapter;
  /** Optional; can also be attached later with setSummarizer(). */
  summarizer?: Summarizer;
}

/** `session:<botId>:<channelId>[:<userId>]` depending on scope. */
export function sessionKey(scope: SessionConfig['scope'], input: SessionKeyInput): string {
  return scope === 'channel'
    ? `session:${input.botId}:${input.channelId}`
    : `session:${input.botId}:${input.channelId}:${input.userId}`;
}

function totalChars(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) total += m.content.length;
  return total;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SessionManager implements SessionManagerLike {
  readonly #botId: string;
  readonly #config: SessionConfig;
  readonly #storage: Storage | undefined;
  readonly #logger: Logger;
  readonly #memory: MemoryAdapter;

  readonly #cache = new Map<string, Session>();
  /** Cold hydration is shared so concurrent callers cannot race separate sessions into cache. */
  readonly #hydrated = new Set<string>();
  readonly #hydrating = new Map<string, Promise<Session | undefined>>();
  /** Future payloads are read-only until an explicit clear removes them. */
  readonly #writeBlocked = new Set<string>();
  /** Per-manager write queue, preserving append/delete order in storage. */
  #pending: Promise<void> = Promise.resolve();
  #summarizer: Summarizer | undefined;
  /** In-flight compaction per session key: at most one summarizer call per session. */
  readonly #compacting = new Map<string, Promise<boolean>>();

  constructor(opts: SessionManagerOptions) {
    this.#botId = opts.botId;
    this.#config = opts.config;
    this.#storage = opts.storage;
    this.#logger = opts.logger;
    this.#memory = opts.memory ?? nullMemoryAdapter;
    this.#summarizer = opts.summarizer;
  }

  /** Attach (or detach with undefined) the LLM summarizer. */
  setSummarizer(summarizer: Summarizer | undefined): void {
    this.#summarizer = summarizer;
  }

  /** True when turns are folded into a summary instead of being hard-dropped. */
  get summarizing(): boolean {
    return this.#config.contextSummary.enabled && this.#summarizer !== undefined;
  }

  keyFor(input: SessionKeyInput): string {
    return sessionKey(this.#config.scope, { ...input, botId: input.botId || this.#botId });
  }

  get #persistEnabled(): boolean {
    return this.#config.persist && this.#storage !== undefined;
  }

  async get(input: SessionKeyInput): Promise<Session> {
    const key = this.keyFor(input);
    const cached = this.#cache.get(key);
    if (cached) return cached;

    let restored: Session | undefined;
    if (this.#persistEnabled && !this.#hydrated.has(key)) {
      let hydration = this.#hydrating.get(key);
      if (!hydration) {
        hydration = this.#hydrate(key, input).finally(() => {
          this.#hydrating.delete(key);
          this.#hydrated.add(key);
        });
        this.#hydrating.set(key, hydration);
      }
      restored = await hydration;
    }

    const raced = this.#cache.get(key);
    if (raced) return raced;

    const session: Session = restored ?? {
      key,
      botId: input.botId || this.#botId,
      channelId: input.channelId,
      userId: this.#config.scope === 'channel' ? undefined : input.userId,
      messages: [],
      updatedAt: Date.now(),
    };
    this.#cache.set(key, session);
    return session;
  }

  async #hydrate(key: string, input: SessionKeyInput): Promise<Session | undefined> {
    const storage = this.#storage;
    if (!storage) return undefined;
    try {
      const raw = await storage.get<unknown>(key);
      if (raw === undefined) return undefined;
      const decoded = decodePersistedSession(raw, key);
      if (!decoded.ok) {
        if (decoded.reason === 'future_version') this.#writeBlocked.add(key);
        this.#logger.warn({ key, reason: decoded.reason }, 'skipping unsupported persisted session');
        return undefined;
      }
      if (decoded.droppedMessages > 0) {
        this.#logger.warn({ key, dropped: decoded.droppedMessages }, 'dropped invalid persisted session messages');
      }
      const stored = decoded.value;
      return {
        key,
        botId: stored.botId || input.botId || this.#botId,
        channelId: stored.channelId || input.channelId,
        userId: this.#config.scope === 'channel' ? undefined : (stored.userId ?? input.userId),
        messages: [...stored.messages],
        ...(stored.summary ? { summary: { ...stored.summary } } : {}),
        updatedAt: stored.updatedAt,
      };
    } catch (error) {
      this.#logger.warn({ key, error: describe(error) }, 'session hydrate failed');
      return undefined;
    }
  }

  async append(input: SessionKeyInput, message: ChatMessage): Promise<void> {
    const session = await this.get(input);
    session.messages.push(message);
    this.#trim(session);
    session.updatedAt = Date.now();
    this.#save(session);
    this.#scheduleCompaction(session);
  }

  /**
   * Close out one exchange: persist the assistant reply and hand the full
   * user+assistant pair to the long-term memory adapter.
   *
   * The user turn is appended earlier by the pipeline (it must be in the
   * history before the prompt is built), so only the assistant turn is
   * appended here.
   *
   * This is the single call site of MemoryAdapter.remember(), so attaching a
   * real Memory Layer needs no pipeline change. Memory failures are swallowed:
   * long-term recall is a bonus, never a reason to lose a reply.
   */
  async completeExchange(input: SessionKeyInput, user: ChatMessage, assistant: ChatMessage): Promise<void> {
    await this.append(input, assistant);

    if (this.#memory === nullMemoryAdapter) return;
    try {
      await this.#memory.remember({
        botId: input.botId,
        channelId: input.channelId,
        userId: input.userId,
        user,
        assistant,
      });
    } catch (error) {
      this.#logger.warn(
        { adapter: this.#memory.name, error: describe(error) },
        'memory remember failed; short-term context is unaffected',
      );
    }
  }

  async updateSourceMessage(input: SourceMessageUpdate): Promise<boolean> {
    return this.#mutateSourceMessage(input, (message) => {
      if (message.deleted || message.content === input.content) return false;
      message.content = input.content;
      return true;
    });
  }

  async deleteSourceMessage(input: SourceMessageMutation): Promise<boolean> {
    return this.#mutateSourceMessage(input, (message) => {
      if (message.deleted) return false;
      message.deleted = true;
      return true;
    });
  }

  async #mutateSourceMessage(
    input: SourceMessageMutation,
    mutate: (message: ChatMessage) => boolean,
  ): Promise<boolean> {
    const sessions = await this.#sourceCandidates(input);
    for (const session of sessions) {
      const message = session.messages.find((candidate) => candidate.role === 'user'
        && candidate.sourceMessageId === input.sourceMessageId
        && candidate.sourcePlatform === input.sourcePlatform);
      if (!message) continue;
      if (!mutate(message)) return false;
      session.updatedAt = Date.now();
      this.#save(session);
      return true;
    }
    return false;
  }

  async #sourceCandidates(input: SourceMessageMutation): Promise<Session[]> {
    if (this.#config.scope === 'channel' || input.userId) {
      return [await this.get({
        botId: input.botId,
        channelId: input.channelId,
        userId: input.userId ?? '',
      })];
    }

    const prefix = `session:${input.botId || this.#botId}:${input.channelId}:`;
    const candidates = [...this.#cache.values()].filter((session) => session.key.startsWith(prefix));
    const seen = new Set(candidates.map((session) => session.key));
    if (!this.#persistEnabled || !this.#storage) return candidates;

    try {
      const stored = await this.#storage.query<unknown>({ prefix });
      for (const row of stored) {
        if (seen.has(row.key)) continue;
        const decoded = decodePersistedSession(row.value, row.key);
        if (!decoded.ok) { this.#logger.warn({ key: row.key, reason: decoded.reason }, 'skipping unsupported persisted session'); continue; }
        const value = decoded.value;
        const session: Session = {
          key: row.key,
          botId: value.botId || input.botId || this.#botId,
          channelId: value.channelId || input.channelId,
          userId: value.userId,
          messages: value.messages.map((message) => ({ ...message })),
          ...(value.summary ? { summary: { ...value.summary } } : {}),
          updatedAt: value.updatedAt,
        };
        this.#cache.set(row.key, session);
        this.#hydrated.add(row.key);
        candidates.push(session);
        seen.add(row.key);
      }
    } catch (error) {
      this.#logger.warn({ prefix, error: describe(error) }, 'session source lookup failed');
    }
    return candidates;
  }

  /** Enforce maxMessages then maxChars, dropping the oldest turns first. */
  #trim(session: Session): void {
    // While summarizing, the message ceiling sits above the compaction trigger
    // so the oldest turns get folded into the summary before the hard trim can
    // drop them. Without a summarizer this is exactly the legacy behaviour.
    const maxMessages = this.summarizing
      ? Math.max(this.#config.maxMessages, this.#config.contextSummary.trimAtRounds * 2 + 4)
      : this.#config.maxMessages;
    const maxChars = this.#config.maxChars;

    if (session.messages.length > maxMessages) {
      session.messages.splice(0, session.messages.length - maxMessages);
    }

    let total = totalChars(session.messages);
    while (total > maxChars && session.messages.length > 1) {
      const dropped = session.messages.shift();
      total -= dropped?.content.length ?? 0;
    }

    const only = session.messages[0];
    if (session.messages.length === 1 && only && only.content.length > maxChars) {
      session.messages[0] = { ...only, content: only.content.slice(0, maxChars) };
    }
  }

  // ── LLM summary compaction ───────────────────────────────────────────

  /** Size trigger: enough rounds, or the char budget is nearly used up. */
  #needsSizeCompaction(session: Session): boolean {
    const cs = this.#config.contextSummary;
    if (session.messages.length - cs.minKeepMessages <= 0) return false;
    const active = session.messages.filter((m) => !m.deleted);
    if (Math.ceil(active.length / 2) >= cs.trimAtRounds) return true;
    return totalChars(active) >= this.#config.maxChars * cs.triggerRatio;
  }

  /** Oldest messages to fold in: trimRemoveRounds rounds, extended until the chars fit half the budget. */
  #pickSizeHead(session: Session): ChatMessage[] {
    const cs = this.#config.contextSummary;
    const messages = session.messages;
    const cap = messages.length - cs.minKeepMessages;
    if (cap <= 0) return [];
    let n = Math.min(cap, cs.trimRemoveRounds * 2);
    const target = this.#config.maxChars * 0.5;
    let remaining = 0;
    for (let i = n; i < messages.length; i += 1) if (!messages[i]!.deleted) remaining += messages[i]!.content.length;
    while (n < cap && remaining > target) {
      const next = messages[n]!;
      if (!next.deleted) remaining -= next.content.length;
      n += 1;
    }
    return messages.slice(0, n);
  }

  /** Leading turns older than summaryAgeHours (turns without a timestamp are never "old"). */
  #pickAgeHead(session: Session, now: number): ChatMessage[] {
    const cs = this.#config.contextSummary;
    const cap = session.messages.length - cs.minKeepMessages;
    if (cap <= 0) return [];
    const cutoff = now - cs.summaryAgeHours * 3_600_000;
    let n = 0;
    while (n < cap) {
      const at = session.messages[n]!.createdAt;
      if (at === undefined || at >= cutoff) break;
      n += 1;
    }
    const head = session.messages.slice(0, n);
    // Not worth an LLM call for a couple of stray lines.
    return head.filter((m) => !m.deleted).length >= 4 ? head : [];
  }

  #scheduleCompaction(session: Session, mode: 'size' | 'age' = 'size'): boolean {
    if (!this.summarizing || this.#compacting.has(session.key)) return false;
    if (this.#writeBlocked.has(session.key)) return false;
    if (mode === 'size' && !this.#needsSizeCompaction(session)) return false;
    const task = this.#compact(session, mode).catch((error: unknown) => {
      this.#logger.warn({ key: session.key, error: describe(error) }, 'context compaction failed; keeping data');
      return false;
    }).finally(() => {
      if (this.#compacting.get(session.key) === task) this.#compacting.delete(session.key);
    });
    this.#compacting.set(session.key, task);
    return true;
  }

  /**
   * One compaction pass. The slow summarizer call runs outside any lock, so the
   * merge re-checks that the session is still live and its head is untouched;
   * otherwise the result is discarded and the data stays as it was.
   */
  async #compact(session: Session, mode: 'size' | 'age'): Promise<boolean> {
    const summarizer = this.#summarizer;
    if (!summarizer) return false;
    const cs = this.#config.contextSummary;
    const head = mode === 'size' ? this.#pickSizeHead(session) : this.#pickAgeHead(session, Date.now());
    if (head.length === 0) return false;

    const active = head.filter((m) => !m.deleted && m.role !== 'system');
    const stillValid = (): boolean => this.#cache.get(session.key) === session
      && session.messages.length >= head.length
      && head.every((m, i) => session.messages[i] === m);

    let text: string | undefined;
    if (active.length > 0) {
      const raw = await summarizer({ previousSummary: session.summary?.text, messages: active.map((m) => ({ ...m })), maxChars: cs.maxSummaryChars });
      text = raw?.trim();
      if (!text) {
        this.#logger.debug({ key: session.key, mode }, 'summarizer returned nothing; keeping data');
        return false;
      }
      if (text.length > cs.maxSummaryChars) text = text.slice(0, cs.maxSummaryChars);
    }
    // Tombstone-only heads are simply dropped; nothing to summarize.
    if (!stillValid()) {
      this.#logger.debug({ key: session.key, mode }, 'session changed during summarization; result discarded');
      return false;
    }
    session.messages.splice(0, head.length);
    const now = Date.now();
    if (text) {
      session.summary = { text, updatedAt: now, coveredMessages: (session.summary?.coveredMessages ?? 0) + active.length };
    }
    session.updatedAt = now;
    this.#save(session);
    this.#logger.info({ key: session.key, mode, folded: active.length, kept: session.messages.length }, 'context compacted into summary');
    return true;
  }

  /**
   * Periodic age-based compaction of idle cached sessions. Schedules work in
   * the background and returns how many sessions were queued, so a slow model
   * can never stall the housekeeping task. Sessions already evicted from the
   * cache are picked up the next time they are hydrated and appended to.
   */
  async sweepCompaction(now: number = Date.now()): Promise<number> {
    const cs = this.#config.contextSummary;
    if (!this.summarizing || !cs.sweepEnabled) return 0;
    let queued = 0;
    for (const session of this.#cache.values()) {
      if (this.#compacting.has(session.key)) continue;
      if (this.#needsSizeCompaction(session)) {
        if (this.#scheduleCompaction(session, 'size')) queued += 1;
        continue;
      }
      const recentlySummarized = session.summary !== undefined && now - session.summary.updatedAt < cs.minIntervalHours * 3_600_000;
      if (recentlySummarized) continue;
      if (this.#pickAgeHead(session, now).length === 0) continue;
      if (this.#scheduleCompaction(session, 'age')) queued += 1;
    }
    return queued;
  }

  async buildContext(input: SessionKeyInput, systemPrompt: string): Promise<ChatMessage[]> {
    const session = await this.get(input);

    const activeMessages = session.messages.filter((message) => !message.deleted);
    let query = '';
    for (let i = activeMessages.length - 1; i >= 0; i -= 1) {
      const m = activeMessages[i];
      if (m && m.role === 'user') {
        query = m.content;
        break;
      }
    }

    let recalled: ChatMessage[] = [];
    try {
      const result = await this.#memory.recall({
        botId: input.botId || this.#botId,
        channelId: input.channelId,
        userId: input.userId,
        query,
      });
      if (Array.isArray(result)) recalled = result;
    } catch (error) {
      this.#logger.warn(
        { adapter: this.#memory.name, error: describe(error) },
        'memory recall failed; continuing without long-term context',
      );
    }

    // Time awareness: stamp every stored user turn with its local timestamp so
    // the model can reason about "刚才/昨天/深夜" without guessing. Rendered at
    // context-build time only — raw storage stays untouched.
    const stamped = activeMessages.map((message) => {
      if (message.role !== 'user' || !message.createdAt) return message;
      const d = new Date(message.createdAt);
      if (Number.isNaN(d.getTime())) return message;
      const pad = (n: number): string => String(n).padStart(2, '0');
      const stamp = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      return { ...message, content: `[${stamp}] ${message.content}` };
    });

    return [{ role: 'system', content: systemPrompt }, ...recalled, ...stamped];
  }

  /** Rolling summary of turns compacted out of the live window, if any. */
  async getSummary(input: SessionKeyInput): Promise<string | undefined> {
    const session = await this.get(input);
    return session.summary?.text;
  }

  async clear(input: SessionKeyInput): Promise<void> {
    const key = this.keyFor(input);
    this.#cache.delete(key);
    this.#compacting.delete(key);
    this.#hydrated.delete(key);
    this.#hydrating.delete(key);
    this.#writeBlocked.delete(key);
    const storage = this.#storage;
    if (!this.#config.persist || !storage) return;
    await this.#track(key, 'session delete failed', async () => {
      await storage.delete(key);
    });
  }

  async clearChannel(channelId: string): Promise<number> {
    const prefix = `session:${this.#botId}:${channelId}`;
    const matches = (key: string): boolean => key === prefix || key.startsWith(`${prefix}:`);
    const keys = new Set([...this.#cache.keys(), ...this.#hydrated].filter(matches));
    if (this.#persistEnabled && this.#storage) {
      try {
        for (const row of await this.#storage.query({ prefix })) if (matches(row.key)) keys.add(row.key);
      } catch (error) {
        this.#logger.warn({ prefix, error: describe(error) }, 'session channel query failed');
      }
    }
    for (const key of keys) {
      this.#cache.delete(key);
      this.#compacting.delete(key);
      this.#hydrated.delete(key);
      this.#hydrating.delete(key);
      if (this.#persistEnabled && this.#storage) await this.#track(key, 'session channel delete failed', () => this.#storage!.delete(key));
    }
    return keys.size;
  }

  async sweep(): Promise<number> {
    const cutoff = Date.now() - this.#config.ttlSeconds * 1000;
    let removed = 0;
    for (const [key, session] of this.#cache) {
      if (session.updatedAt < cutoff && !this.#compacting.has(key)) {
        this.#cache.delete(key);
        this.#hydrated.delete(key);
        this.#hydrating.delete(key);
        removed += 1;
      }
    }
    if (removed > 0) this.#logger.debug({ removed, remaining: this.#cache.size }, 'swept idle sessions');
    return removed;
  }

  size(): number {
    return this.#cache.size;
  }

  /** Await every fire-and-forget storage write (graceful shutdown / tests). */
  async flush(): Promise<void> {
    // A finished compaction queues a save, so drain compactions first.
    while (this.#compacting.size > 0) {
      await Promise.allSettled([...this.#compacting.values()]);
    }
    await this.#pending;
  }

  /** Fire-and-forget write-behind. Never rejects, never blocks the caller. */
  #save(session: Session): void {
    const storage = this.#storage;
    if (!this.#config.persist || !storage) return;
    if (this.#writeBlocked.has(session.key)) {
      this.#logger.warn({ key: session.key }, 'refusing to overwrite future persisted session');
      return;
    }
    const record: PersistedSession = {
      kind: 'session',
      // v2 only when a summary exists, so unsummarized sessions stay readable by older builds.
      recordVersion: session.summary ? 2 : 1,
      key: session.key,
      botId: session.botId,
      channelId: session.channelId,
      userId: session.userId,
      messages: session.messages.map((m) => ({ ...m })),
      ...(session.summary ? { summary: { ...session.summary } } : {}),
      updatedAt: session.updatedAt,
    };
    void this.#track(session.key, 'session persist failed', async () => {
      await storage.save(session.key, record, this.#config.ttlSeconds);
    });
  }

  /** Queue `work` after prior writes; failures are logged and never rethrown. */
  #track(key: string, message: string, work: () => Promise<void>): Promise<void> {
    const queued = this.#pending.then(work).catch((error: unknown) => {
      this.#logger.warn({ key, error: describe(error) }, message);
    });
    this.#pending = queued;
    return queued;
  }
}
