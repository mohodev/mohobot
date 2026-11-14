/** Simple sliding-window per-key rate limiter. */
export class RateLimiter {
  readonly #hits = new Map<string, number[]>();

  constructor(
    private readonly windowMs: number,
    private readonly max: number,
  ) {
    if (!Number.isFinite(windowMs) || windowMs < 1) throw new Error('windowMs must be positive');
    if (!Number.isSafeInteger(max) || max < 1) throw new Error('max must be a positive integer');
  }

  allow(key: string): boolean {
    const now = Date.now();
    const list = (this.#hits.get(key) ?? []).filter((timestamp) => now - timestamp < this.windowMs);
    if (list.length >= this.max) {
      this.#hits.set(key, list);
      return false;
    }
    list.push(now);
    this.#hits.set(key, list);
    return true;
  }

  /** Drop stale buckets so the map cannot grow without bound. */
  sweep(): void {
    const now = Date.now();
    for (const [key, list] of this.#hits) {
      const live = list.filter((timestamp) => now - timestamp < this.windowMs);
      if (live.length === 0) this.#hits.delete(key);
      else this.#hits.set(key, live);
    }
  }
}
