import crypto from 'node:crypto';

export interface RedisClientLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { PX: number }): Promise<unknown>;
  del(key: string): Promise<number>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

export type RedisRateLimitMode = 'fixed' | 'sliding';
export interface RedisRateLimitResult { allowed: boolean; limit: number; remaining: number; resetAt: number; }

export class RedisUnavailableError extends Error {
  readonly code = 'REDIS_UNAVAILABLE';
  override readonly cause?: unknown;
  constructor(operation: string, cause?: unknown) {
    super(`Redis unavailable during ${operation}`);
    this.name = 'RedisUnavailableError';
    this.cause = cause;
  }
}

export function isRedisUnavailable(error: unknown): error is RedisUnavailableError {
  return error instanceof RedisUnavailableError;
}

export interface RedisAdapterOptions {
  client: RedisClientLike;
  namespace: string;
  now?: () => number;
  nonce?: () => string;
}

const NAMESPACE = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,63}$/;
const MAX_KEY_BYTES = 512;

// KEYS and ARGV are supplied only by RedisAdapter; callers cannot inject Lua.
export const FIXED_WINDOW_SCRIPT = `-- mohobot:fixed-window:v1
local current = redis.call('INCR', KEYS[1])
if current == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return {current, ttl}`;

export const SLIDING_WINDOW_SCRIPT = `-- mohobot:sliding-window:v1
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local current = redis.call('ZCARD', KEYS[1])
local accepted = 0
if current < limit then
  redis.call('ZADD', KEYS[1], now, ARGV[4])
  current = current + 1
  accepted = 1
end
redis.call('PEXPIRE', KEYS[1], window)
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
local reset = now + window
if oldest[2] then reset = tonumber(oldest[2]) + window end
return {current, reset, accepted}`;

/**
 * Optional Redis acceleration for distributed TTL cache and rate limiting.
 * Persistent data must live in SQLite/MySQL; Redis failures are surfaced as a
 * typed unavailable error so callers can fall back to their local adapters.
 */
export class RedisAdapter {
  readonly #client: RedisClientLike;
  readonly #namespace: string;
  readonly #now: () => number;
  readonly #nonce: () => string;

  constructor(options: RedisAdapterOptions) {
    if (!NAMESPACE.test(options.namespace)) throw new Error('invalid Redis namespace');
    this.#client = options.client;
    this.#namespace = options.namespace;
    this.#now = options.now ?? Date.now;
    this.#nonce = options.nonce ?? (() => crypto.randomUUID());
  }

  async getJson<T>(key: string): Promise<T | undefined> {
    try {
      const value = await this.#client.get(this.#key('cache', key));
      if (value === null) return undefined;
      return JSON.parse(value) as T;
    } catch (error) {
      throw new RedisUnavailableError('cache get', error);
    }
  }

  async setJson(key: string, value: unknown, ttlMs: number): Promise<void> {
    const ttl = positiveInteger(ttlMs, 'cache TTL');
    let encoded: string | undefined;
    try { encoded = JSON.stringify(value); }
    catch (error) { throw new TypeError(`cache value is not JSON serializable: ${String(error)}`); }
    if (encoded === undefined) throw new TypeError('cache value is not JSON serializable');
    try { await this.#client.set(this.#key('cache', key), encoded, { PX: ttl }); }
    catch (error) { throw new RedisUnavailableError('cache set', error); }
  }

  async delete(key: string): Promise<boolean> {
    try { return (await this.#client.del(this.#key('cache', key))) > 0; }
    catch (error) { throw new RedisUnavailableError('cache delete', error); }
  }

  async rateLimit(input: { key: string; limit: number; windowMs: number; mode?: RedisRateLimitMode }): Promise<RedisRateLimitResult> {
    const limit = positiveInteger(input.limit, 'rate limit');
    const windowMs = positiveInteger(input.windowMs, 'rate window');
    const now = Math.floor(this.#now());
    if (!Number.isFinite(now) || now < 0) throw new Error('invalid clock value');
    const mode = input.mode ?? 'sliding';
    try {
      if (mode === 'fixed') {
        const raw = await this.#client.eval(FIXED_WINDOW_SCRIPT, {
          keys: [this.#key('rate:fixed', input.key)],
          arguments: [String(windowMs)],
        });
        const [count, ttl] = resultPair(raw, 'fixed-window');
        return { allowed: count <= limit, limit, remaining: Math.max(0, limit - count), resetAt: now + Math.max(0, ttl) };
      }
      const raw = await this.#client.eval(SLIDING_WINDOW_SCRIPT, {
        keys: [this.#key('rate:sliding', input.key)],
        arguments: [String(now), String(windowMs), String(limit), `${now}:${this.#nonce()}`],
      });
      const values = resultTuple(raw, 3, 'sliding-window');
      const count = values[0]!;
      const resetAt = values[1]!;
      const accepted = values[2]!;
      return { allowed: accepted === 1, limit, remaining: Math.max(0, limit - count), resetAt };
    } catch (error) {
      if (error instanceof RedisUnavailableError) throw error;
      throw new RedisUnavailableError(`${mode}-window rate limit`, error);
    }
  }

  #key(bucket: string, logicalKey: string): string {
    if (typeof logicalKey !== 'string' || logicalKey.length === 0) throw new Error('Redis logical key is required');
    if (Buffer.byteLength(logicalKey) > MAX_KEY_BYTES) throw new Error(`Redis logical key exceeds ${MAX_KEY_BYTES} bytes`);
    return `${this.#namespace}:${bucket}:${Buffer.from(logicalKey, 'utf8').toString('base64url')}`;
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function resultPair(value: unknown, operation: string): [number, number] {
  const [first, second] = resultTuple(value, 2, operation);
  return [first!, second!];
}

function resultTuple(value: unknown, length: number, operation: string): number[] {
  if (!Array.isArray(value) || value.length < length) throw new Error(`invalid ${operation} Redis result`);
  const output = value.slice(0, length).map(Number);
  if (output.some((item) => !Number.isFinite(item))) throw new Error(`invalid ${operation} Redis result`);
  return output;
}
