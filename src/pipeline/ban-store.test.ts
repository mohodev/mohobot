import { describe, expect, it } from 'vitest';

import { createNullLogger } from '../core/logger.js';
import { MemoryStorage } from '../storage/memory.js';
import { BanError, BanStore, formatDuration, looksLikeDuration, normalizeUserId, parseDuration } from './ban-store.js';

const logger = createNullLogger();
const HOUR = 3_600_000;

async function storage(): Promise<MemoryStorage> {
  const s = new MemoryStorage({ logger });
  await s.init();
  return s;
}

describe('duration parsing', () => {
  it('parses combined units and caps at one year', () => {
    expect(parseDuration('30m')).toBe(30 * 60_000);
    expect(parseDuration('1d2h')).toBe(26 * HOUR);
    expect(parseDuration('1H30m10S')).toBe(HOUR + 30 * 60_000 + 10_000);
    expect(parseDuration('9999d')).toBe(365 * 24 * HOUR);
  });

  it('rejects garbage and zero', () => {
    for (const bad of ['', 'abc', '10', '1x', '0s', '1d 2h', '-5m', '1.5h']) {
      expect(() => parseDuration(bad), bad).toThrow(BanError);
    }
  });

  it('detects duration-shaped tokens without throwing', () => {
    expect(looksLikeDuration('2h')).toBe(true);
    expect(looksLikeDuration('1d2h30m')).toBe(true);
    expect(looksLikeDuration('spam')).toBe(false);
    expect(looksLikeDuration('2hours')).toBe(false);
  });

  it('formats durations compactly', () => {
    expect(formatDuration(26 * HOUR + 5_000)).toBe('1d2h5s');
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(90_000)).toBe('1m30s');
  });
});

describe('user id normalization', () => {
  it('accepts bare ids and mentions, rejects the rest', () => {
    expect(normalizeUserId('123456789012345678')).toBe('123456789012345678');
    expect(normalizeUserId('<@123456789012345678>')).toBe('123456789012345678');
    expect(normalizeUserId('<@!42>')).toBe('42');
    for (const bad of ['', 'a b', '<@>', 'x'.repeat(65), 'a/b', '../etc']) expect(() => normalizeUserId(bad), bad).toThrow(BanError);
  });
});

describe('BanStore', () => {
  it('bans globally and per channel, and unbans', async () => {
    const store = new BanStore(await storage(), logger);
    await store.ban({ userId: '111', by: 'admin' });
    await store.ban({ userId: '222', channelId: 'chanA', by: 'admin', reason: 'spam' });

    expect(store.check('111', 'anywhere')?.userId).toBe('111');
    expect(store.check('222', 'chanA')?.reason).toBe('spam');
    expect(store.check('222', 'chanB')).toBeUndefined();
    expect(store.check('333', 'chanA')).toBeUndefined();

    expect(await store.unban('111')).toBe(true);
    expect(await store.unban('111')).toBe(false);
    expect(store.check('111', 'anywhere')).toBeUndefined();
    expect(await store.unban('222')).toBe(false); // channel ban is not a global one
    expect(await store.unban('222', 'chanA')).toBe(true);
  });

  it('expires bans on its own and prunes them from the list', async () => {
    let now = 1_000_000;
    const store = new BanStore(await storage(), logger, () => now);
    await store.ban({ userId: '111', durationMs: HOUR, by: 'admin' });
    await store.ban({ userId: '222', by: 'admin' });
    expect(store.list().map((r) => r.userId).sort()).toEqual(['111', '222']);

    now += HOUR - 1;
    expect(store.check('111')).toBeDefined();
    now += 2;
    expect(store.check('111')).toBeUndefined();
    expect(store.list().map((r) => r.userId)).toEqual(['222']);
  });

  it('persists bans across instances and respects expiry after a restart', async () => {
    const s = await storage();
    const first = new BanStore(s, logger);
    await first.ban({ userId: '111', by: 'admin', reason: 'x' });
    await first.ban({ userId: '222', durationMs: 60_000, by: 'admin' });

    const second = new BanStore(s, logger);
    await second.ready();
    expect(second.check('111')?.reason).toBe('x');
    expect(second.check('222')).toBeDefined();

    const later = Date.now() + 120_000;
    const third = new BanStore(s, logger, () => later);
    await third.ready();
    expect(third.check('111')).toBeDefined();
    expect(third.check('222')).toBeUndefined();
  });

  it('shares one cache per Storage so bots in a process agree instantly', async () => {
    const s = await storage();
    const a = BanStore.for(s, logger);
    const b = BanStore.for(s, logger);
    expect(a).toBe(b);
    await a.ban({ userId: '111', by: 'admin' });
    expect(b.check('111')).toBeDefined();
    expect(BanStore.for(await storage(), logger)).not.toBe(a);
  });

  it('works memory-only without storage', async () => {
    const store = BanStore.for(undefined, logger);
    await store.ban({ userId: '111', by: 'admin' });
    expect(store.check('111')).toBeDefined();
    expect(BanStore.for(undefined, logger)).not.toBe(store);
  });

  it('survives a broken storage without throwing', async () => {
    const boom = async (): Promise<never> => { throw new Error('disk on fire'); };
    const broken = { init: boom, save: boom, get: boom, delete: boom, query: boom, purgeExpired: boom, close: boom } as never;
    const store = new BanStore(broken, logger);
    await expect(store.ready()).resolves.toBeUndefined();
    await expect(store.ban({ userId: '111', by: 'admin' })).resolves.toMatchObject({ userId: '111' });
    expect(store.check('111')).toBeDefined(); // still enforced in memory
    await expect(store.unban('111')).resolves.toBe(true);
  });

  it('skips malformed persisted records but keeps good ones', async () => {
    const s = await storage();
    await s.save('ban:global:bad', { kind: 'ban', recordVersion: 9 });
    await s.save('ban:global:worse', 'nonsense');
    await s.save('ban:global:111', { kind: 'ban', recordVersion: 1, userId: '111', createdBy: 'a', createdAt: 1 });
    const store = new BanStore(s, logger);
    await store.ready();
    expect(store.list().map((r) => r.userId)).toEqual(['111']);
  });

  it('validates input and sanitizes the reason', async () => {
    const store = new BanStore(await storage(), logger);
    await expect(store.ban({ userId: 'not valid!', by: 'a' })).rejects.toMatchObject({ code: 'invalid_user' });
    await expect(store.ban({ userId: '1', durationMs: -5, by: 'a' })).rejects.toMatchObject({ code: 'invalid_duration' });
    await expect(store.ban({ userId: '1', channelId: '  ', by: 'a' })).rejects.toMatchObject({ code: 'invalid_scope' });
    const record = await store.ban({ userId: '1', by: 'a', reason: `line1\nline2\u0007${'x'.repeat(500)}` });
    expect(record.reason).not.toMatch(/[\u0000-\u001f]/);
    expect(record.reason!.length).toBeLessThanOrEqual(200);
  });

  it('prefers a channel ban lookup but falls back to the global one', async () => {
    const store = new BanStore(await storage(), logger);
    await store.ban({ userId: '1', by: 'a' });
    await store.ban({ userId: '1', channelId: 'c', by: 'a', reason: 'channel' });
    expect(store.check('1', 'c')?.reason).toBe('channel');
    expect(store.check('1', 'other')?.channelId).toBeUndefined();
  });
});
