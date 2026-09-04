/**
 * Ban store for the ban plugin.
 *
 * A single, globally shared ban list across all bots (mirrors the upstream
 * "全局统一封禁名单"). Records persist through the plugin's scoped storage so
 * they survive restarts. Semantics: the bot silently ignores a banned user's
 * messages - this is NOT a server moderation ban.
 */

import type { ScopedStorage } from '../../src/storage/types.js';

export type BanScope = 'channel' | 'global';
export type BanKind = 'ban' | 'pass';

export interface BanRecord {
  kind: BanKind;
  userId: string;
  scope: BanScope;
  /** Channel id when scope is 'channel'. */
  channelId?: string;
  /** Epoch ms; undefined = permanent. */
  until?: number;
  reason?: string;
  by?: string;
  createdAt: number;
}

export interface ResolveResult {
  banned: boolean;
  /** The record that decided the outcome, if any. */
  record?: BanRecord;
}

const KEY = 'bans';

export class BanStore {
  readonly #storage: ScopedStorage;
  #records: BanRecord[] = [];

  constructor(storage: ScopedStorage) {
    this.#storage = storage;
  }

  async load(): Promise<void> {
    try {
      const stored = await this.#storage.get<BanRecord[]>(KEY);
      this.#records = Array.isArray(stored) ? stored : [];
    } catch {
      this.#records = [];
    }
  }

  records(): BanRecord[] {
    return [...this.#records];
  }

  /** Drop expired records; returns how many were removed. */
  prune(now = Date.now()): number {
    const before = this.#records.length;
    this.#records = this.#records.filter((record) => record.until === undefined || record.until > now);
    return before - this.#records.length;
  }

  async add(record: BanRecord): Promise<void> {
    // A new entry supersedes an existing one for the same user/scope/kind.
    this.#records = this.#records.filter(
      (r) => !(r.userId === record.userId && r.scope === record.scope && r.kind === record.kind
        && (r.channelId ?? '') === (record.channelId ?? '')),
    );
    this.#records.push(record);
    await this.#save();
  }

  async remove(userId: string, scope: BanScope, channelId?: string, kind?: BanKind): Promise<number> {
    const before = this.#records.length;
    this.#records = this.#records.filter((r) => {
      if (r.userId !== userId) return true;
      if (r.scope !== scope) return true;
      if (kind && r.kind !== kind) return true;
      if (scope === 'channel' && (r.channelId ?? '') !== (channelId ?? '')) return true;
      return false;
    });
    await this.#save();
    return before - this.#records.length;
  }

  async clear(userId: string): Promise<number> {
    const before = this.#records.length;
    this.#records = this.#records.filter((r) => r.userId !== userId);
    await this.#save();
    return before - this.#records.length;
  }

  /**
   * Resolve whether a user is banned in the given channel.
   * Priority (upstream): channel pass > channel ban > global pass > global ban.
   */
  resolve(userId: string, channelId: string, now = Date.now()): ResolveResult {
    const live = this.#records.filter((r) => r.until === undefined || r.until > now);
    const channelPass = live.find((r) => r.kind === 'pass' && r.scope === 'channel' && (r.channelId ?? '') === channelId && r.userId === userId);
    if (channelPass) return { banned: false };
    const channelBan = live.find((r) => r.kind === 'ban' && r.scope === 'channel' && (r.channelId ?? '') === channelId && r.userId === userId);
    if (channelBan) return { banned: true, record: channelBan };
    const globalPass = live.find((r) => r.kind === 'pass' && r.scope === 'global' && r.userId === userId);
    if (globalPass) return { banned: false };
    const globalBan = live.find((r) => r.kind === 'ban' && r.scope === 'global' && r.userId === userId);
    if (globalBan) return { banned: true, record: globalBan };
    return { banned: false };
  }

  async #save(): Promise<void> {
    try {
      await this.#storage.save(KEY, this.#records);
    } catch {
      /* persistence is best-effort; in-memory state remains authoritative */
    }
  }
}
