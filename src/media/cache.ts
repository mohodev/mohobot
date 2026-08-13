export interface MediaCacheMetadata<T = unknown> {
  sha256: string;
  size: number;
  contentType?: string;
  createdAt: number;
  expiresAt: number;
  lastAccessedAt: number;
  value?: T;
}

export interface MediaHashCacheOptions {
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
}

/**
 * In-memory TTL/LRU metadata cache keyed by a validated SHA-256 digest.
 * Downloaded bytes are intentionally never retained; callers may cache safe
 * derived data such as captions, OCR text, or perceptual hashes in `value`.
 */
export class MediaHashCache<T = unknown> {
  readonly #entries = new Map<string, MediaCacheMetadata<T>>();
  readonly #maxEntries: number;
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(options: MediaHashCacheOptions = {}) {
    this.#maxEntries = options.maxEntries ?? 256;
    this.#ttlMs = options.ttlMs ?? 60 * 60 * 1000;
    this.#now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.#maxEntries) || this.#maxEntries <= 0) throw new Error('maxEntries must be a positive safe integer');
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs <= 0) throw new Error('ttlMs must be a positive safe integer');
  }

  get size(): number { this.#purgeExpired(); return this.#entries.size; }

  get(sha256: string): MediaCacheMetadata<T> | undefined {
    const key = digest(sha256);
    const found = this.#entries.get(key);
    if (!found) return undefined;
    const now = this.#now();
    if (found.expiresAt <= now) { this.#entries.delete(key); return undefined; }
    const refreshed = { ...found, lastAccessedAt: now };
    // Map insertion order is the LRU order; refresh accessed entries to MRU.
    this.#entries.delete(key);
    this.#entries.set(key, refreshed);
    return clone(refreshed);
  }

  set(input: { sha256: string; size: number; contentType?: string; value?: T; ttlMs?: number }): MediaCacheMetadata<T> {
    const key = digest(input.sha256);
    if (!Number.isSafeInteger(input.size) || input.size < 0) throw new Error('media size must be a non-negative safe integer');
    const ttlMs = input.ttlMs ?? this.#ttlMs;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error('ttlMs must be a positive safe integer');
    const now = this.#now();
    const entry: MediaCacheMetadata<T> = { sha256: key, size: input.size, contentType: input.contentType, createdAt: now, expiresAt: now + ttlMs, lastAccessedAt: now, value: input.value };
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    this.#purgeExpired();
    while (this.#entries.size > this.#maxEntries) this.#entries.delete(this.#entries.keys().next().value!);
    return clone(entry);
  }

  has(sha256: string): boolean { return this.get(sha256) !== undefined; }
  delete(sha256: string): boolean { return this.#entries.delete(digest(sha256)); }
  clear(): void { this.#entries.clear(); }

  #purgeExpired(): void {
    const now = this.#now();
    for (const [key, entry] of this.#entries) if (entry.expiresAt <= now) this.#entries.delete(key);
  }
}

function digest(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error('invalid SHA-256 digest');
  return normalized;
}

function clone<T>(entry: MediaCacheMetadata<T>): MediaCacheMetadata<T> { return { ...entry }; }
