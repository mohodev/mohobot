import { describe, expect, it } from 'vitest';
import { FIXED_WINDOW_SCRIPT, RedisAdapter, RedisUnavailableError, SLIDING_WINDOW_SCRIPT, type RedisClientLike } from './redis-adapter.js';

class FakeRedis implements RedisClientLike {
  readonly values = new Map<string, string>();
  readonly sets: Array<{ key: string; value: string; px: number }> = [];
  readonly evals: Array<{ script: string; keys: string[]; arguments: string[] }> = [];
  evalResult: unknown = [1, 1000];
  failure?: Error;
  async get(key: string): Promise<string | null> { if (this.failure) throw this.failure; return this.values.get(key) ?? null; }
  async set(key: string, value: string, options: { PX: number }): Promise<void> { if (this.failure) throw this.failure; this.values.set(key, value); this.sets.push({ key, value, px: options.PX }); }
  async del(key: string): Promise<number> { if (this.failure) throw this.failure; return Number(this.values.delete(key)); }
  async eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> { if (this.failure) throw this.failure; this.evals.push({ script, ...options }); return this.evalResult; }
}

describe('RedisAdapter cache', () => {
  it('stores JSON with TTL under an encoded, fixed namespace', async () => {
    const client = new FakeRedis();
    const adapter = new RedisAdapter({ client, namespace: 'mohobot:test' });
    await adapter.setJson('user:1/private', { ok: true }, 5000);
    expect(client.sets).toHaveLength(1);
    expect(client.sets[0]?.key).toMatch(/^mohobot:test:cache:/);
    expect(client.sets[0]?.key).not.toContain('user:1/private');
    expect(client.sets[0]?.px).toBe(5000);
    await expect(adapter.getJson('user:1/private')).resolves.toEqual({ ok: true });
    await expect(adapter.delete('user:1/private')).resolves.toBe(true);
  });

  it('rejects unsafe namespaces, invalid TTL and non-JSON values', async () => {
    const client = new FakeRedis();
    expect(() => new RedisAdapter({ client, namespace: 'bad namespace' })).toThrow('namespace');
    const adapter = new RedisAdapter({ client, namespace: 'safe' });
    await expect(adapter.setJson('key', {}, 0)).rejects.toThrow('positive integer');
    await expect(adapter.setJson('key', undefined, 100)).rejects.toThrow('not JSON serializable');
  });

  it('returns typed unavailable errors for local fallback', async () => {
    const client = new FakeRedis();
    client.failure = new Error('connection refused');
    const adapter = new RedisAdapter({ client, namespace: 'safe' });
    await expect(adapter.getJson('key')).rejects.toMatchObject({ name: 'RedisUnavailableError', code: 'REDIS_UNAVAILABLE' });
    await expect(adapter.setJson('key', 1, 100)).rejects.toBeInstanceOf(RedisUnavailableError);
  });

  it('treats malformed cached JSON as unavailable instead of returning corrupt data', async () => {
    const client = new FakeRedis();
    const adapter = new RedisAdapter({ client, namespace: 'safe' });
    client.values.set('safe:cache:a2V5', '{bad');
    await expect(adapter.getJson('key')).rejects.toMatchObject({ code: 'REDIS_UNAVAILABLE' });
  });
});

describe('RedisAdapter distributed rate limits', () => {
  it('uses the built-in fixed-window script and reports remaining quota', async () => {
    const client = new FakeRedis();
    client.evalResult = [3, 750];
    const adapter = new RedisAdapter({ client, namespace: 'moho', now: () => 1000 });
    await expect(adapter.rateLimit({ key: 'user', limit: 5, windowMs: 1000, mode: 'fixed' }))
      .resolves.toEqual({ allowed: true, limit: 5, remaining: 2, resetAt: 1750 });
    expect(client.evals[0]?.script).toBe(FIXED_WINDOW_SCRIPT);
    expect(client.evals[0]?.keys[0]).toMatch(/^moho:rate:fixed:/);
    expect(client.evals[0]?.arguments).toEqual(['1000']);
  });

  it('uses an atomic sliding-window script with bounded membership', async () => {
    const client = new FakeRedis();
    client.evalResult = [5, 1900, 1];
    const adapter = new RedisAdapter({ client, namespace: 'moho', now: () => 1000, nonce: () => 'nonce' });
    await expect(adapter.rateLimit({ key: 'channel:user', limit: 5, windowMs: 1000 }))
      .resolves.toEqual({ allowed: true, limit: 5, remaining: 0, resetAt: 1900 });
    expect(client.evals[0]?.script).toBe(SLIDING_WINDOW_SCRIPT);
    expect(client.evals[0]?.arguments).toEqual(['1000', '1000', '5', '1000:nonce']);
  });

  it('marks a full sliding window as rejected without exceeding the count', async () => {
    const client = new FakeRedis();
    client.evalResult = [5, 1900, 0];
    const adapter = new RedisAdapter({ client, namespace: 'moho', now: () => 1000 });
    await expect(adapter.rateLimit({ key: 'user', limit: 5, windowMs: 1000 }))
      .resolves.toMatchObject({ allowed: false, remaining: 0 });
  });

  it('marks over-limit fixed windows as rejected', async () => {
    const client = new FakeRedis();
    client.evalResult = [6, 500];
    const adapter = new RedisAdapter({ client, namespace: 'moho', now: () => 1000 });
    await expect(adapter.rateLimit({ key: 'user', limit: 5, windowMs: 1000, mode: 'fixed' }))
      .resolves.toMatchObject({ allowed: false, remaining: 0 });
  });

  it('rejects malformed Redis script results as unavailable', async () => {
    const client = new FakeRedis();
    client.evalResult = ['not-a-number'];
    const adapter = new RedisAdapter({ client, namespace: 'moho' });
    await expect(adapter.rateLimit({ key: 'user', limit: 1, windowMs: 1000 }))
      .rejects.toMatchObject({ code: 'REDIS_UNAVAILABLE' });
  });
});
