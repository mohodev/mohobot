/**
 * Runtime ban list (ported in spirit from upstream's global ban system).
 *
 * Semantics: a banned user is silently ignored by the bot - this is NOT a
 * Discord guild ban. Two scopes: `global` (every channel, every bot sharing the
 * storage) and `channel` (one channel). Bans may expire; expiry is enforced by
 * the record itself and by storage TTL, so a restart can never resurrect an
 * expired ban or lose a live one.
 *
 * One instance per Storage (see BanStore.for) keeps the in-memory cache
 * coherent across the bots of a single process.
 */

import type { Logger } from '../core/logger.js';
import type { Storage } from '../storage/types.js';

export const BAN_PREFIX = 'ban:';
const MAX_DURATION_MS = 365 * 24 * 3_600_000;
const MAX_REASON_CHARS = 200;
const USER_ID = /^[\w.-]{1,64}$/;
const DURATION_PART = /(\d+)([dhms])/gy;
const DURATION_FULL = /^(?:\d+[dhms])+$/;
const UNIT_MS = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 } as const;

export class BanError extends Error {
  constructor(readonly code: 'invalid_user' | 'invalid_duration' | 'invalid_scope', message: string) {
    super(message);
    this.name = 'BanError';
  }
}

export interface BanRecord {
  kind: 'ban';
  recordVersion: 1;
  userId: string;
  /** Undefined = global. */
  channelId?: string;
  reason?: string;
  createdBy: string;
  createdAt: number;
  /** Undefined = permanent. */
  expiresAt?: number;
}

export interface BanInput {
  userId: string;
  channelId?: string;
  durationMs?: number;
  reason?: string;
  by: string;
}

/** `<@123>`, `<@!123>` or a bare id -> bare id. */
export function normalizeUserId(raw: string): string {
  const match = /^<@!?([\w.-]{1,64})>$/.exec(raw.trim());
  const id = match ? match[1]! : raw.trim();
  if (!USER_ID.test(id)) throw new BanError('invalid_user', 'invalid user id');
  return id;
}

export function looksLikeDuration(text: string): boolean {
  return DURATION_FULL.test(text.trim().toLowerCase());
}

/** `1d2h30m10s` -> milliseconds. Capped at one year; zero/garbage is rejected. */
export function parseDuration(text: string): number {
  const value = text.trim().toLowerCase();
  if (!DURATION_FULL.test(value)) throw new BanError('invalid_duration', `invalid duration "${text}" (use e.g. 30m, 2h, 1d2h)`);
  DURATION_PART.lastIndex = 0;
  let total = 0;
  for (let m = DURATION_PART.exec(value); m !== null; m = DURATION_PART.exec(value)) {
    total += Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS];
  }
  if (!Number.isSafeInteger(total) || total <= 0) throw new BanError('invalid_duration', 'duration must be positive');
  return Math.min(total, MAX_DURATION_MS);
}

export function formatDuration(ms: number): string {
  let rest = Math.max(0, Math.round(ms / 1000));
  const parts: string[] = [];
  for (const [unit, size] of [['d', 86_400], ['h', 3_600], ['m', 60], ['s', 1]] as const) {
    const n = Math.floor(rest / size);
    if (n > 0) { parts.push(`${n}${unit}`); rest -= n * size; }
  }
  return parts.length ? parts.join('') : '0s';
}

function keyOf(userId: string, channelId?: string): string {
  return channelId ? `${BAN_PREFIX}channel:${channelId}:${userId}` : `${BAN_PREFIX}global:${userId}`;
}

function decode(value: unknown): BanRecord | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (v.kind !== 'ban' || v.recordVersion !== 1 || typeof v.userId !== 'string' || !USER_ID.test(v.userId)
    || typeof v.createdBy !== 'string' || typeof v.createdAt !== 'number' || !Number.isFinite(v.createdAt)) return undefined;
  if (v.channelId !== undefined && (typeof v.channelId !== 'string' || !v.channelId)) return undefined;
  if (v.expiresAt !== undefined && (typeof v.expiresAt !== 'number' || !Number.isFinite(v.expiresAt))) return undefined;
  if (v.reason !== undefined && typeof v.reason !== 'string') return undefined;
  return {
    kind: 'ban', recordVersion: 1, userId: v.userId, createdBy: v.createdBy, createdAt: v.createdAt,
    ...(v.channelId !== undefined ? { channelId: v.channelId as string } : {}),
    ...(v.expiresAt !== undefined ? { expiresAt: v.expiresAt as number } : {}),
    ...(v.reason !== undefined ? { reason: (v.reason as string).slice(0, MAX_REASON_CHARS) } : {}),
  };
}

const instances = new WeakMap<Storage, BanStore>();

export class BanStore {
  readonly #storage: Storage | undefined;
  readonly #logger: Logger | undefined;
  readonly #cache = new Map<string, BanRecord>();
  readonly #now: () => number;
  #loading: Promise<void> | undefined;

  constructor(storage?: Storage, logger?: Logger, now: () => number = Date.now) {
    this.#storage = storage;
    this.#logger = logger?.child({ component: 'bans' });
    this.#now = now;
  }

  /** Shared instance per Storage; storage-less callers get an isolated memory-only store. */
  static for(storage: Storage | undefined, logger?: Logger): BanStore {
    if (!storage) return new BanStore(undefined, logger);
    let store = instances.get(storage);
    if (!store) { store = new BanStore(storage, logger); instances.set(storage, store); }
    return store;
  }

  /** Load persisted bans once. Storage trouble degrades to "no bans", never to a crash. */
  ready(): Promise<void> {
    this.#loading ??= this.#load();
    return this.#loading;
  }

  async #load(): Promise<void> {
    if (!this.#storage) return;
    try {
      for (const row of await this.#storage.query<unknown>({ prefix: BAN_PREFIX })) {
        const record = decode(row.value);
        if (record) this.#cache.set(row.key, record);
        else this.#logger?.warn({ key: row.key }, 'ignoring malformed ban record');
      }
    } catch (error) {
      this.#logger?.warn({ err: error instanceof Error ? error.message : String(error) }, 'ban list load failed; continuing with an empty list');
    }
  }

  #live(record: BanRecord): boolean {
    return record.expiresAt === undefined || record.expiresAt > this.#now();
  }

  async ban(input: BanInput): Promise<BanRecord> {
    await this.ready();
    const userId = normalizeUserId(input.userId);
    if (input.channelId !== undefined && !input.channelId.trim()) throw new BanError('invalid_scope', 'channel id must not be empty');
    if (input.durationMs !== undefined && (!Number.isSafeInteger(input.durationMs) || input.durationMs <= 0)) {
      throw new BanError('invalid_duration', 'duration must be positive');
    }
    const now = this.#now();
    const reason = input.reason?.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_REASON_CHARS);
    const record: BanRecord = {
      kind: 'ban', recordVersion: 1, userId, createdBy: input.by, createdAt: now,
      ...(input.channelId ? { channelId: input.channelId } : {}),
      ...(input.durationMs !== undefined ? { expiresAt: now + Math.min(input.durationMs, MAX_DURATION_MS) } : {}),
      ...(reason ? { reason } : {}),
    };
    const key = keyOf(userId, input.channelId);
    this.#cache.set(key, record);
    if (this.#storage) {
      const ttl = record.expiresAt === undefined ? undefined : Math.max(1, Math.ceil((record.expiresAt - now) / 1000));
      try { await this.#storage.save(key, record, ttl); }
      catch (error) { this.#logger?.warn({ err: error instanceof Error ? error.message : String(error) }, 'ban persisted in memory only'); }
    }
    return record;
  }

  async unban(userIdRaw: string, channelId?: string): Promise<boolean> {
    await this.ready();
    const userId = normalizeUserId(userIdRaw);
    const key = keyOf(userId, channelId);
    const existed = this.#cache.delete(key);
    if (this.#storage) {
      try { await this.#storage.delete(key); }
      catch (error) { this.#logger?.warn({ err: error instanceof Error ? error.message : String(error) }, 'ban removal not persisted'); }
    }
    return existed;
  }

  /** Active ban that applies to this user in this channel (channel scope first). Expired entries are pruned. */
  check(userId: string, channelId?: string): BanRecord | undefined {
    for (const key of [channelId ? keyOf(userId, channelId) : undefined, keyOf(userId)]) {
      if (!key) continue;
      const record = this.#cache.get(key);
      if (!record) continue;
      if (this.#live(record)) return record;
      this.#cache.delete(key);
    }
    return undefined;
  }

  list(): BanRecord[] {
    const out: BanRecord[] = [];
    for (const [key, record] of this.#cache) {
      if (this.#live(record)) out.push(record); else this.#cache.delete(key);
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }
}
