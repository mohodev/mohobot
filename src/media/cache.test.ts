import { describe, expect, it } from 'vitest';
import { MediaHashCache } from './cache.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

describe('MediaHashCache', () => {
  it('stores metadata and safe derived values without media bytes', () => {
    const cache = new MediaHashCache<{ caption: string }>({ ttlMs: 1000, now: () => 100 });
    const entry = cache.set({ sha256: A.toUpperCase(), size: 42, contentType: 'image/png', value: { caption: 'a screenshot' } });
    expect(entry).toMatchObject({ sha256: A, size: 42, createdAt: 100, expiresAt: 1100, value: { caption: 'a screenshot' } });
    expect(cache.get(A)).toMatchObject({ value: { caption: 'a screenshot' } });
    expect(entry).not.toHaveProperty('bytes');
  });

  it('expires entries using TTL without timers', () => {
    let now = 0;
    const cache = new MediaHashCache({ ttlMs: 10, now: () => now });
    cache.set({ sha256: A, size: 1 });
    now = 9;
    expect(cache.has(A)).toBe(true);
    now = 10;
    expect(cache.get(A)).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('evicts the least recently used entry', () => {
    let now = 0;
    const cache = new MediaHashCache({ maxEntries: 2, ttlMs: 1000, now: () => ++now });
    cache.set({ sha256: A, size: 1 });
    cache.set({ sha256: B, size: 2 });
    cache.get(A); // A becomes most recently used.
    cache.set({ sha256: C, size: 3 });
    expect(cache.has(A)).toBe(true);
    expect(cache.has(B)).toBe(false);
    expect(cache.has(C)).toBe(true);
  });

  it('supports per-entry TTL, deletion, and clearing', () => {
    let now = 5;
    const cache = new MediaHashCache({ ttlMs: 100, now: () => now });
    cache.set({ sha256: A, size: 1, ttlMs: 5 });
    cache.set({ sha256: B, size: 1 });
    expect(cache.delete(A)).toBe(true);
    expect(cache.has(A)).toBe(false);
    now = 50;
    expect(cache.has(B)).toBe(true);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('validates digests, sizes, capacities, and TTLs', () => {
    expect(() => new MediaHashCache({ maxEntries: 0 })).toThrow();
    expect(() => new MediaHashCache({ ttlMs: 0 })).toThrow();
    const cache = new MediaHashCache();
    expect(() => cache.set({ sha256: 'bad', size: 1 })).toThrow();
    expect(() => cache.set({ sha256: A, size: -1 })).toThrow();
    expect(() => cache.set({ sha256: A, size: 1, ttlMs: 0 })).toThrow();
    expect(() => cache.get('not-a-digest')).toThrow();
  });
});
