/**
 * In-memory Storage with exactly the same semantics as SqliteStorage.
 *
 * Values are JSON-serialised on write so callers cannot mutate stored state by
 * holding on to a reference - matching what a real database does.
 */

import type { Logger } from '../core/logger.js';
import type { QueryFilter, Storage, StoredRecord } from './types.js';

interface Entry {
  value: string;
  updatedAt: number;
  expiresAt: number | null;
}

export interface MemoryStorageOptions {
  logger: Logger;
}

function sanitizeCount(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const int = Math.trunc(value);
  return int < 0 ? fallback : int;
}

export class MemoryStorage implements Storage {
  readonly #rows = new Map<string, Entry>();
  readonly #log: Logger;
  #open = false;

  constructor(opts: MemoryStorageOptions) {
    this.#log = opts.logger.child({ mod: 'storage', driver: 'memory' });
  }

  async init(): Promise<void> {
    this.#open = true;
    this.#log.debug({}, 'memory storage ready');
  }

  async save<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    this.#must();
    const now = Date.now();
    const expiresAt =
      typeof ttlSeconds === 'number' && Number.isFinite(ttlSeconds) && ttlSeconds > 0
        ? now + Math.trunc(ttlSeconds * 1000)
        : null;
    this.#rows.set(key, { value: JSON.stringify(value ?? null), updatedAt: now, expiresAt });
  }

  async get<T>(key: string): Promise<T | undefined> {
    this.#must();
    const entry = this.#rows.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.#rows.delete(key);
      return undefined;
    }
    return this.#decode<T>(key, entry.value);
  }

  async delete(key: string): Promise<void> {
    this.#must();
    this.#rows.delete(key);
  }

  async query<T>(filter: QueryFilter = {}): Promise<StoredRecord<T>[]> {
    this.#must();
    const now = Date.now();
    const prefix = typeof filter.prefix === 'string' ? filter.prefix : '';

    const matched: StoredRecord<T>[] = [];
    for (const [key, entry] of this.#rows) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) continue;
      if (prefix.length > 0 && !key.startsWith(prefix)) continue;
      const value = this.#decode<T>(key, entry.value);
      if (value === undefined) continue;
      matched.push({
        key,
        value,
        updatedAt: entry.updatedAt,
        ...(entry.expiresAt !== null ? { expiresAt: entry.expiresAt } : {}),
      });
    }

    matched.sort((a, b) => (b.updatedAt - a.updatedAt) || a.key.localeCompare(b.key));

    const offset = sanitizeCount(filter.offset, 0);
    const limit = sanitizeCount(filter.limit, -1);
    const sliced = matched.slice(offset);
    return limit >= 0 ? sliced.slice(0, limit) : sliced;
  }

  async purgeExpired(): Promise<number> {
    this.#must();
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of [...this.#rows]) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) {
        this.#rows.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  async close(): Promise<void> {
    this.#rows.clear();
    this.#open = false;
  }

  #must(): void {
    if (!this.#open) throw new Error('MemoryStorage not initialised - call init() first');
  }

  #decode<T>(key: string, raw: string): T | undefined {
    try {
      return JSON.parse(raw) as T;
    } catch (error) {
      this.#log.warn(
        { key, error: error instanceof Error ? error.message : String(error) },
        'skipping corrupt JSON row',
      );
      return undefined;
    }
  }
}
