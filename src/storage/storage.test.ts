/**
 * One suite, run against every Storage implementation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createNullLogger } from '../core/logger.js';
import { scopeStorage } from './index.js';
import { MemoryStorage } from './memory.js';
import { SqliteStorage } from './sqlite.js';
import type { Storage } from './types.js';

const logger = createNullLogger();

const drivers: Array<{ name: string; make: () => Storage }> = [
  { name: 'MemoryStorage', make: () => new MemoryStorage({ logger }) },
  { name: 'SqliteStorage(:memory:)', make: () => new SqliteStorage({ path: ':memory:', logger }) },
];

for (const driver of drivers) {
  describe(driver.name, () => {
    let storage: Storage;

    beforeEach(async () => {
      storage = driver.make();
      await storage.init();
    });

    afterEach(async () => {
      vi.useRealTimers();
      await storage.close();
    });

    it('roundtrips a value', async () => {
      await storage.save('user:1', { name: 'moho', tags: ['a', 'b'] });
      expect(await storage.get<{ name: string; tags: string[] }>('user:1')).toEqual({
        name: 'moho',
        tags: ['a', 'b'],
      });
    });

    it('returns undefined for a missing key', async () => {
      expect(await storage.get('nope')).toBeUndefined();
    });

    it('stores a copy, not a live reference', async () => {
      const value = { n: 1 };
      await storage.save('copy:1', value);
      value.n = 99;
      expect(await storage.get<{ n: number }>('copy:1')).toEqual({ n: 1 });
    });

    it('overwrites an existing key', async () => {
      await storage.save('k', 'first');
      await storage.save('k', 'second');
      expect(await storage.get<string>('k')).toBe('second');
      const rows = await storage.query({ prefix: 'k' });
      expect(rows).toHaveLength(1);
    });

    it('deletes a key', async () => {
      await storage.save('gone', 1);
      await storage.delete('gone');
      expect(await storage.get('gone')).toBeUndefined();
      await expect(storage.delete('gone')).resolves.toBeUndefined();
    });

    it('queries by prefix with limit and offset', async () => {
      await storage.save('user:1', 1);
      await storage.save('user:2', 2);
      await storage.save('other:1', 3);

      const all = await storage.query<number>({ prefix: 'user:' });
      expect(all.map((r) => r.key).sort()).toEqual(['user:1', 'user:2']);
      expect(all.every((r) => typeof r.updatedAt === 'number')).toBe(true);

      const limited = await storage.query<number>({ prefix: 'user:', limit: 1 });
      expect(limited).toHaveLength(1);

      const offset = await storage.query<number>({ prefix: 'user:', offset: 1 });
      expect(offset).toHaveLength(1);

      const beyond = await storage.query<number>({ prefix: 'user:', offset: 5 });
      expect(beyond).toHaveLength(0);

      const everything = await storage.query<number>({});
      expect(everything).toHaveLength(3);
    });

    it('expires a value once its ttl elapses', async () => {
      vi.useFakeTimers();
      await storage.save('ttl:a', 'here', 1);
      await storage.save('ttl:b', 'forever');
      expect(await storage.get<string>('ttl:a')).toBe('here');

      vi.advanceTimersByTime(1500);

      expect(await storage.get('ttl:a')).toBeUndefined();
      expect(await storage.get<string>('ttl:b')).toBe('forever');
      // The expired row is gone for good (lazy delete on read).
      expect(await storage.query({ prefix: 'ttl:' })).toHaveLength(1);
    });

    it('purgeExpired removes only expired rows and reports the count', async () => {
      vi.useFakeTimers();
      await storage.save('p:1', 1, 1);
      await storage.save('p:2', 2, 1);
      await storage.save('p:3', 3);

      expect(await storage.purgeExpired()).toBe(0);

      vi.advanceTimersByTime(2000);

      expect(await storage.purgeExpired()).toBe(2);
      expect(await storage.purgeExpired()).toBe(0);
      expect(await storage.get<number>('p:3')).toBe(3);
    });

    it('scopeStorage isolates two namespaces', async () => {
      const a = scopeStorage(storage, 'plugin-a');
      const b = scopeStorage(storage, 'plugin-b');

      await a.save('k', 'A');
      await b.save('k', 'B');

      expect(await a.get<string>('k')).toBe('A');
      expect(await b.get<string>('k')).toBe('B');

      const rowsA = await a.query<string>({});
      expect(rowsA.map((r) => r.key)).toEqual(['k']);
      expect(rowsA[0]?.value).toBe('A');

      // The underlying store really is prefixed.
      expect(await storage.get<string>('plugin-a:k')).toBe('A');

      await a.delete('k');
      expect(await a.get('k')).toBeUndefined();
      expect(await b.get<string>('k')).toBe('B');
    });

    it('scopeStorage honours an inner prefix filter', async () => {
      const scoped = scopeStorage(storage, 'ns');
      await scoped.save('session:1', 1);
      await scoped.save('cache:1', 2);

      const sessions = await scoped.query<number>({ prefix: 'session:' });
      expect(sessions.map((r) => r.key)).toEqual(['session:1']);
    });
  });
}
