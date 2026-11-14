import fs from 'node:fs/promises';
import path from 'node:path';
import { SqliteStorage } from '../storage/sqlite.js';
import type { Storage } from '../storage/types.js';
import { createNullLogger } from '../core/logger.js';

export type AffinityDeltaReason = 'helpful' | 'kind' | 'shared-interest' | 'conflict' | 'ignored' | 'manual';
export interface AffinityRecord { botId: string; userId: string; score: number; interactions: number; lastReason: AffinityDeltaReason; updatedAt: string; notes: string[]; }

const AFFINITY_KEY = 'affinity:records';
const DEFAULT_RECORD = (botId: string, userId: string): AffinityRecord => ({
  botId, userId, score: 0, interactions: 0, lastReason: 'manual',
  updatedAt: new Date(0).toISOString(), notes: [],
});

function clamp(value: number): number {
  return Math.max(-100, Math.min(100, Math.round(value * 100) / 100));
}

function normalizeRows(value: unknown): AffinityRecord[] {
  if (!Array.isArray(value)) throw new Error('affinity data must be an array');
  return value as AffinityRecord[];
}

function legacyPayload(value: unknown, file: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const row = value as { format?: unknown; version?: unknown; revision?: unknown; data?: unknown };
  if (row.format !== 'mohobot-json') return value;
  if (!Number.isSafeInteger(row.version) || !Number.isSafeInteger(row.revision) || !('data' in row)) {
    throw new Error('invalid versioned affinity JSON envelope');
  }
  if (Number(row.version) > 1) {
    throw new Error(`unsupported future affinity JSON version ${row.version} in ${file}`);
  }
  if (Number(row.version) < 1 || Number(row.revision) < 1) {
    throw new Error('invalid versioned affinity JSON metadata');
  }
  return row.data;
}

/**
 * Affinity persistence backed by the shared SQLite KV store.
 *
 * The old data/memory/affinity.json file is a read-only migration source. It is
 * deliberately never rewritten or deleted, so downgrade/recovery remains possible.
 */
export class AffinityStore {
  readonly #storage: Storage;
  readonly #ownsStorage: boolean;
  readonly #legacyFile: string;
  #ready?: Promise<void>;

  constructor(rootDir: string, storage?: Storage) {
    this.#storage = storage ?? new SqliteStorage({
      path: path.join(rootDir, 'data', 'mohobot.db'),
      logger: createNullLogger(),
    });
    this.#ownsStorage = storage === undefined;
    this.#legacyFile = path.join(rootDir, 'data', 'memory', 'affinity.json');
  }

  async get(botId: string, userId: string): Promise<AffinityRecord> {
    const rows = await this.#readRows();
    return rows.find((row) => row.botId === botId && row.userId === userId) ?? DEFAULT_RECORD(botId, userId);
  }

  async list(botId?: string): Promise<AffinityRecord[]> {
    return (await this.#readRows())
      .filter((row) => !botId || row.botId === botId)
      .sort((a, b) => b.score - a.score);
  }

  async adjust(botId: string, userId: string, delta: number, reason: AffinityDeltaReason, note?: string): Promise<AffinityRecord> {
    // SQLite compare-and-set keeps concurrent processes/instances from losing updates.
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const currentRows = await this.#readRows();
      const current = currentRows.find((row) => row.botId === botId && row.userId === userId)
        ?? DEFAULT_RECORD(botId, userId);
      const result: AffinityRecord = {
        ...current,
        score: clamp(current.score + delta),
        interactions: current.interactions + 1,
        lastReason: reason,
        updatedAt: new Date().toISOString(),
        notes: note ? [...current.notes, note].slice(-20) : current.notes,
      };
      const nextRows = [
        ...currentRows.filter((row) => row.botId !== botId || row.userId !== userId),
        result,
      ];
      const changed = this.#storage.compareAndSet
        ? await this.#storage.compareAndSet(AFFINITY_KEY, currentRows, nextRows)
        : (await this.#storage.save(AFFINITY_KEY, nextRows), true);
      if (changed) return result;
    }
    throw new Error('affinity update contention exceeded retry limit');
  }

  async close(): Promise<void> {
    if (this.#ownsStorage) await this.#storage.close();
  }

  async #readRows(): Promise<AffinityRecord[]> {
    this.#ready ??= this.#storage.init();
    await this.#ready;

    const current = await this.#storage.get<AffinityRecord[]>(AFFINITY_KEY);
    if (current !== undefined) return normalizeRows(current);

    const legacy = await this.#readLegacy();
    const initial = normalizeRows(legacy ?? []);
    if (this.#storage.compareAndSet) {
      await this.#storage.compareAndSet(AFFINITY_KEY, undefined, initial);
    } else {
      await this.#storage.save(AFFINITY_KEY, initial);
    }
    const migrated = await this.#storage.get<AffinityRecord[]>(AFFINITY_KEY);
    if (migrated === undefined) throw new Error('affinity SQLite initialization did not persist');
    return normalizeRows(migrated);
  }

  async #readLegacy(): Promise<unknown | undefined> {
    let raw: string;
    try {
      raw = await fs.readFile(this.#legacyFile, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    return legacyPayload(JSON.parse(raw) as unknown, this.#legacyFile);
  }
}
