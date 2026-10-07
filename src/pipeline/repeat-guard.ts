/**
 * Auto-reply / repeat noise filter (ported from upstream's private-chat
 * auto-reply filter, generalised).
 *
 * Two silent-ignore rules, both cheap and local:
 *  1. text that announces itself as an auto-reply ("[自动回复] ...");
 *  2. the same author repeating the same text `maxRepeats` times in a row
 *     inside `windowMs` - spam, stuck clients, and bot-to-bot echo loops (a
 *     whitelisted peer bot repeating itself would otherwise keep us talking).
 *
 * State is bounded: expired keys are pruned and the table is size-capped.
 */

export interface RepeatGuardOptions {
  maxRepeats: number;
  windowMs: number;
  /** Hard cap on tracked authors; oldest entries are dropped first. */
  maxKeys?: number;
  now?: () => number;
}

export type NoiseReason = 'auto_reply' | 'repeat';

const AUTO_REPLY_PREFIX = /^\s*[[【(（]\s*(?:自动回复|auto[-\s]?reply)\s*[\]】)）]/i;

/** Collapse case/whitespace so trivially different copies still count as the same text. */
export function normalizeForRepeat(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function looksLikeAutoReply(text: string): boolean {
  return AUTO_REPLY_PREFIX.test(text);
}

interface Streak {
  text: string;
  count: number;
  lastAt: number;
}

export class RepeatGuard {
  readonly #maxRepeats: number;
  readonly #windowMs: number;
  readonly #maxKeys: number;
  readonly #now: () => number;
  readonly #streaks = new Map<string, Streak>();

  constructor(options: RepeatGuardOptions) {
    this.#maxRepeats = Math.max(2, Math.floor(options.maxRepeats));
    this.#windowMs = Math.max(1, options.windowMs);
    this.#maxKeys = Math.max(10, options.maxKeys ?? 5_000);
    this.#now = options.now ?? Date.now;
  }

  /**
   * Record one message from `key` and say whether it should be ignored.
   * An ignored repeat still extends its streak, so a stuck sender stays muted
   * until they say something different or go quiet for a full window.
   */
  inspect(key: string, text: string): NoiseReason | undefined {
    if (looksLikeAutoReply(text)) return 'auto_reply';
    const normalized = normalizeForRepeat(text);
    if (!normalized) return undefined;

    const now = this.#now();
    const streak = this.#streaks.get(key);
    if (streak && streak.text === normalized && now - streak.lastAt < this.#windowMs) {
      streak.count += 1;
      streak.lastAt = now;
      // Refresh recency so Map iteration order stays "oldest first".
      this.#streaks.delete(key);
      this.#streaks.set(key, streak);
      return streak.count >= this.#maxRepeats ? 'repeat' : undefined;
    }

    this.#streaks.delete(key);
    this.#streaks.set(key, { text: normalized, count: 1, lastAt: now });
    this.#evict(now);
    return undefined;
  }

  #evict(now: number): void {
    if (this.#streaks.size <= this.#maxKeys) return;
    for (const [key, streak] of this.#streaks) {
      if (now - streak.lastAt >= this.#windowMs) this.#streaks.delete(key);
    }
    while (this.#streaks.size > this.#maxKeys) {
      const oldest = this.#streaks.keys().next();
      if (oldest.done) break;
      this.#streaks.delete(oldest.value);
    }
  }

  size(): number {
    return this.#streaks.size;
  }

  clear(): void {
    this.#streaks.clear();
  }
}
