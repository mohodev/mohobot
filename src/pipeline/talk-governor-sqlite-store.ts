import type { Storage } from '../storage/types.js';
import type { TalkGovernorChannelState, TalkGovernorStateStore } from './talk-governor-state.js';

const KEY_PREFIX = 'talk-governor:';

/** JSON-safe shape persisted in SQLite via the Storage KV interface. */
interface PersistedChannelState {
  delivered: number[];
  lastAt: number;
  consecutive: number;
  backoffUntil: number;
  focusUntil: number;
  pending: [string, number][];
}

function toJSON(state: TalkGovernorChannelState): PersistedChannelState {
  return {
    delivered: state.delivered,
    lastAt: state.lastAt,
    consecutive: state.consecutive,
    backoffUntil: state.backoffUntil,
    focusUntil: state.focusUntil,
    pending: [...state.pending.entries()],
  };
}

function fromJSON(raw: PersistedChannelState): TalkGovernorChannelState {
  return {
    delivered: Array.isArray(raw.delivered) ? raw.delivered : [],
    lastAt: typeof raw.lastAt === 'number' ? raw.lastAt : 0,
    consecutive: typeof raw.consecutive === 'number' ? raw.consecutive : 0,
    backoffUntil: typeof raw.backoffUntil === 'number' ? raw.backoffUntil : 0,
    focusUntil: typeof raw.focusUntil === 'number' ? raw.focusUntil : 0,
    pending: new Map(Array.isArray(raw.pending) ? raw.pending : []),
  };
}

/**
 * SQLite-backed TalkGovernorStateStore.
 *
 * Keeps an in-memory cache for zero-latency synchronous reads (the
 * TalkGovernorStateStore interface is sync). Writes are scheduled
 * asynchronously; call {@link flush} at shutdown to drain pending saves.
 */
export class SqliteTalkGovernorStateStore implements TalkGovernorStateStore {
  readonly #storage: Storage;
  readonly #cache = new Map<string, TalkGovernorChannelState>();
  readonly #dirty = new Set<string>();
  #flushPromise: Promise<void> | undefined;

  constructor(storage: Storage) {
    this.#storage = storage;
  }

  /** Restore cached state from SQLite. Call once before the governor runs. */
  async init(): Promise<void> {
    const rows = await this.#storage.query<PersistedChannelState>({ prefix: KEY_PREFIX });
    for (const row of rows) {
      const channelId = row.key.slice(KEY_PREFIX.length);
      if (channelId === '_global') continue;
      this.#cache.set(channelId, fromJSON(row.value));
    }
  }

  get(channelId: string): TalkGovernorChannelState | undefined {
    return this.#cache.get(channelId);
  }

  set(channelId: string, state: TalkGovernorChannelState): void {
    this.#cache.set(channelId, state);
    this.#dirty.add(channelId);
    this.#schedulePersist();
  }

  delete(channelId?: string): void {
    if (channelId) {
      this.#cache.delete(channelId);
      this.#dirty.delete(channelId);
      void this.#storage.delete(`${KEY_PREFIX}${channelId}`).catch(() => {});
    } else {
      const keys = [...this.#cache.keys()];
      this.#cache.clear();
      this.#dirty.clear();
      for (const key of keys) {
        void this.#storage.delete(`${KEY_PREFIX}${key}`).catch(() => {});
      }
    }
  }

  /** Drain all pending writes. */
  async flush(): Promise<void> {
    await this.#persist();
    if (this.#flushPromise) await this.#flushPromise;
  }

  #schedulePersist(): void {
    if (this.#flushPromise) return;
    this.#flushPromise = Promise.resolve().then(() => this.#persist()).finally(() => { this.#flushPromise = undefined; });
  }

  async #persist(): Promise<void> {
    const batch = [...this.#dirty];
    this.#dirty.clear();
    const saves = batch.map((channelId) => {
      const state = this.#cache.get(channelId);
      if (!state) return this.#storage.delete(`${KEY_PREFIX}${channelId}`);
      return this.#storage.save(`${KEY_PREFIX}${channelId}`, toJSON(state));
    });
    await Promise.allSettled(saves);
  }
}
