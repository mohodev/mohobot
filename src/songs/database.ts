/**
 * Song knowledge store (kv-backed) + in-memory search index.
 *
 * Upstream keeps songs in SQLite via SQLAlchemy; here everything mutable is
 * the kv store (SQLite remains the only storage driver). The full corpus is
 * small enough to hold names + lyrics in memory for substring matching, which
 * is exactly what the matcher needs. The index rebuilds at boot and after
 * every sync.
 */

import type { Logger } from '../core/logger.js';
import type { Storage } from '../storage/types.js';
import type { SongDetail } from './song.js';

const PREFIX = 'song:';
const INDEX_KEY = 'song:index-names';
const STATS_KEY = 'song:stats';

export interface SongStats {
  totalSongs: number;
  updatedAt: number;
}

export interface SongIndexEntry {
  name: string;
  lyrics: string;
}

export class SongStore {
  readonly #storage: Storage;
  readonly #logger: Logger;
  #index: SongIndexEntry[] = [];
  #loaded = false;

  constructor(deps: { storage: Storage; logger: Logger }) {
    this.#storage = deps.storage;
    this.#logger = deps.logger.child({ component: 'songs' });
  }

  /** Upsert one parsed page. Returns false when the page has no usable song. */
  async upsert(detail: SongDetail): Promise<boolean> {
    const name = detail.name.trim();
    if (!name || !detail.lyrics.trim()) return false;
    await this.#storage.save(`${PREFIX}${name}`, { ...detail, name });
    this.#loaded = false;
    return true;
  }

  async get(name: string): Promise<SongDetail | undefined> {
    try {
      const row = await this.#storage.get<SongDetail>(`${PREFIX}${name.trim()}`);
      return row && typeof row.lyrics === 'string' ? row : undefined;
    } catch {
      return undefined;
    }
  }

  async count(): Promise<number> {
    try {
      const names = await this.#storage.get<string[]>(INDEX_KEY);
      return names?.length ?? 0;
    } catch {
      return 0;
    }
  }

  /** Rebuilds the in-memory index (names + lyrics) from storage. */
  async reload(): Promise<number> {
    const names = new Set<string>();
    try {
      const rows = await this.#storage.query<unknown>({ prefix: PREFIX, limit: 20000 });
      for (const row of rows) {
        const key = row.key;
        if (key === INDEX_KEY || key === STATS_KEY) continue;
        if (typeof key !== 'string' || !key.startsWith(PREFIX)) continue;
        const value = row.value as Partial<SongDetail> | undefined;
        if (value && typeof value.name === 'string' && typeof value.lyrics === 'string' && value.lyrics) {
          names.add(value.name);
        }
      }
    } catch (error) {
      this.#logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'song index reload failed');
    }
    const entries: SongIndexEntry[] = [];
    for (const name of names) {
      const detail = await this.get(name);
      if (detail) entries.push({ name, lyrics: detail.lyrics });
    }
    this.#index = entries;
    this.#loaded = true;
    try {
      await this.#storage.save(INDEX_KEY, [...names]);
      await this.#storage.save(STATS_KEY, { totalSongs: names.size, updatedAt: Date.now() } satisfies SongStats);
    } catch {
      /* index persistence is a convenience, not a requirement */
    }
    this.#logger.info({ songs: entries.length }, 'song index rebuilt');
    return entries.length;
  }

  /** Names only, for substring pre-filtering without touching storage. */
  names(): string[] {
    return this.#index.map((entry) => entry.name);
  }

  index(): ReadonlyArray<SongIndexEntry> {
    return this.#index;
  }

  get loaded(): boolean {
    return this.#loaded;
  }

  async stats(): Promise<SongStats> {
    try {
      return (await this.#storage.get<SongStats>(STATS_KEY)) ?? { totalSongs: 0, updatedAt: 0 };
    } catch {
      return { totalSongs: 0, updatedAt: 0 };
    }
  }
}
