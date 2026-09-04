import { describe, expect, it } from 'vitest';

import { BanStore, type BanRecord } from './store.js';
import { describeUntil, parseDuration } from './time.js';
import { parseTarget } from './index.js';

const DAY = 24 * 60 * 60 * 1000;

function noopStorage() {
  const data = new Map<string, unknown>();
  return {
    data,
    async save<T>(key: string, value: T): Promise<void> { data.set(key, JSON.parse(JSON.stringify(value))); },
    async get<T>(key: string): Promise<T | undefined> { return data.get(key) as T | undefined; },
    async delete(key: string): Promise<void> { data.delete(key); },
    async query<T>() { return []; },
  };
}

describe('parseDuration', () => {
  const now = 1_000_000;
  it('returns permanent for empty input', () => {
    expect(parseDuration('', now).until).toBeUndefined();
  });
  it('parses single and combined units', () => {
    expect(parseDuration('1d', now).until).toBe(now + DAY);
    expect(parseDuration('2h', now).until).toBe(now + 2 * 3600_000);
    expect(parseDuration('30m10s', now).until).toBe(now + 30 * 60_000 + 10_000);
  });
  it('rejects malformed input', () => {
    expect(() => parseDuration('abc')).toThrow();
    expect(() => parseDuration('1x')).toThrow();
    expect(() => parseDuration('1d2x')).toThrow();
  });
});

describe('describeUntil', () => {
  const now = 1_000_000;
  it('describes permanent and expired', () => {
    expect(describeUntil(undefined, now)).toBe('permanent');
    expect(describeUntil(now - 1, now)).toBe('expired');
  });
  it('formats days/hours/minutes', () => {
    expect(describeUntil(now + DAY + 2 * 3600_000, now)).toBe('1d2h');
    expect(describeUntil(now + 2 * 3600_000, now)).toBe('2h0m');
  });
});

describe('parseTarget', () => {
  it('extracts mentions and raw ids', () => {
    expect(parseTarget('<@123456789012345678>')).toBe('123456789012345678');
    expect(parseTarget('<@!9876543210>')).toBe('9876543210');
    expect(parseTarget('12345')).toBe('12345');
  });
  it('rejects junk', () => {
    expect(parseTarget('someone')).toBeUndefined();
    expect(parseTarget(undefined)).toBeUndefined();
  });
});

describe('BanStore', () => {
  const base = (): BanRecord => ({ kind: 'ban', userId: 'u1', scope: 'channel', channelId: 'c1', createdAt: 1 });

  it('resolves priority: channel pass > channel ban > global pass > global ban', async () => {
    const store = new BanStore(noopStorage());
    await store.add(base());
    expect(store.resolve('u1', 'c1').banned).toBe(true);

    await store.add({ ...base(), kind: 'pass' });
    expect(store.resolve('u1', 'c1').banned).toBe(false);

    const store2 = new BanStore(noopStorage());
    await store2.add({ kind: 'ban', userId: 'u1', scope: 'global', createdAt: 1 });
    await store2.add({ kind: 'pass', userId: 'u1', scope: 'global', createdAt: 1 });
    expect(store2.resolve('u1', 'c1').banned).toBe(false);
  });

  it('scopes channel bans to their channel', async () => {
    const store = new BanStore(noopStorage());
    await store.add(base());
    expect(store.resolve('u1', 'other-channel').banned).toBe(false);
    await store.add({ kind: 'ban', userId: 'u1', scope: 'global', createdAt: 1 });
    expect(store.resolve('u1', 'other-channel').banned).toBe(true);
  });

  it('prunes expired records', async () => {
    const store = new BanStore(noopStorage());
    const now = 1_000_000;
    await store.add({ ...base(), until: now + 1000 });
    await store.add({ ...base(), userId: 'u2', until: now - 1 });
    expect(store.prune(now)).toBe(1);
    expect(store.records().length).toBe(1);
  });

  it('persists and reloads', async () => {
    const storage = noopStorage();
    const store = new BanStore(storage);
    await store.add(base());
    const restored = new BanStore(storage);
    await restored.load();
    expect(restored.resolve('u1', 'c1').banned).toBe(true);
  });
});
