import { afterEach, describe, expect, it, vi } from 'vitest';
import { RateLimiter } from './rate-limiter.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('RateLimiter', () => {
  it('limits each key independently inside the sliding window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = new RateLimiter(1_000, 2);

    expect(limiter.allow('user-a')).toBe(true);
    expect(limiter.allow('user-a')).toBe(true);
    expect(limiter.allow('user-a')).toBe(false);
    expect(limiter.allow('user-b')).toBe(true);
  });

  it('allows a key again after the previous hit window expires', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = new RateLimiter(100, 1);

    expect(limiter.allow('user-a')).toBe(true);
    expect(limiter.allow('user-a')).toBe(false);
    vi.setSystemTime(100);
    expect(limiter.allow('user-a')).toBe(true);
  });

  it('sweeps expired buckets without changing live-key decisions', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = new RateLimiter(100, 1);
    expect(limiter.allow('stale')).toBe(true);
    vi.setSystemTime(101);
    limiter.sweep();
    expect(limiter.allow('stale')).toBe(true);
  });
});
