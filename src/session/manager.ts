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
import { compressSession, type Summarize } from './summarizer.js';

export interface SessionManagerOptions {
  botId: string;
  config: SessionConfig;
  storage?: Storage;
  logger: Logger;
  memory?: MemoryAdapter;
  /**
   * Optional context summarizer. When present (and `config.session.summary`
   * is enabled) old turns are compressed into a `summary` block instead of
   * being dropped by the hard trim. Omitting it (or a failing call) leaves
   * the plain maxMessages/maxChars trim as the only behaviour.
   */
  summarize?: Summarize;
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
  readonly #summarize: Summarize | undefined;

  readonly #cache = new Map<string, Session>();
  /** Cold hydration is shared so concurrent callers cannot race separate sessions into cache. */
  readonly #hydrated = new Set<string>();
  readonly #hydrating = new Map<string, Promise<Session | undefined>>();
  /** Future payloads are read-only until an explicit clear removes them. */
  readonly #writeBlocked = new Set<string>();
  /** Per-manager write queue, preserving append/delete order in storage. */
  #pending: Promise<void> = Promise.resolve();

  constructor(opts: SessionManagerOptions) {
    this.#botId = opts.botId;
    this.#config = opts.config;
    this.#storage = opts.storage;
    this.#logger = opts.logger;
    this.#memory = opts.memory ?? nullMemoryAdapter;
    this.#summarize = opts.summarize;
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
    await this.#compress(session);
    this.#trim(session);
    session.updatedAt = Date.now();
    this.#save(session);
  }

  /**
   * Compress old turns into a `summary` block before the hard trim runs. Any
   * failure is logged and the hard trim still applies, so a broken model call
   * can never grow a session past its limits or lose a reply.
   */
  async #compress(session: Session): Promise<void> {
    const cfg = this.#config.summary;
    if (!cfg.enabled || !this.#summarize) return;
    try {
      const result = await compressSession(
        session,
        cfg.triggerMessages,
        cfg.removeMessages,
        cfg.keepMessages,
        this.#summarize,
      );
      if (result.compressed) {
        this.#logger.debug(
          { key: session.key, folded: result.folded, remaining: session.messages.length },
          'session context summarized',
        );
      } else if (result.fallback) {
        this.#logger.warn({ key: session.key, reason: result.fallback }, 'context summary failed; hard trim applied');
      }
    } catch (error) {
      this.#logger.warn({ key: session.key, error: describe(error) }, 'context summary failed; hard trim applied');
    }
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
    const maxMessages = this.#config.maxMessages;
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

  async clear(input: SessionKeyInput): Promise<void> {
    const key = this.keyFor(input);
    this.#cache.delete(key);
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
      if (session.updatedAt < cutoff) {
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
      recordVersion: 1,
      key: session.key,
      botId: session.botId,
      channelId: session.channelId,
      userId: session.userId,
      messages: session.messages.map((m) => ({ ...m })),
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
