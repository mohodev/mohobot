/**
 * Storage module surface: interfaces, drivers, factory and namespacing helper.
 */

import path from 'node:path';

import type { StorageConfig } from '../config/schema.js';
import type { Logger } from '../core/logger.js';
import { registries, type MemoryFactory, type StorageFactory } from '../core/registries.js';
import { MemoryStorage } from './memory.js';
import { SqliteStorage } from './sqlite.js';
import { nullMemoryAdapter, type QueryFilter, type ScopedStorage, type Storage, type StoredRecord } from './types.js';

export * from './types.js';
export * from './sqlite.js';
export * from './memory.js';
export * from './chatlog.js';

export interface CreateStorageOptions {
  /** Project root used to resolve a relative storage path. */
  rootDir: string;
  logger: Logger;
}

export const SQLITE_DRIVER = 'sqlite';
export const MEMORY_DRIVER = 'memory';
export const NULL_MEMORY_ADAPTER = 'null';

const sqliteFactory: StorageFactory = (cfg, deps) => {
  const raw = typeof cfg.path === 'string' && cfg.path.trim().length > 0 ? cfg.path.trim() : './data/mohobot.db';
  const resolved = raw === ':memory:' || path.isAbsolute(raw) ? raw : path.resolve(deps.rootDir, raw);
  return new SqliteStorage({ path: resolved, logger: deps.logger });
};
const memoryFactory: StorageFactory = (_cfg, deps) => new MemoryStorage({ logger: deps.logger });
const nullMemoryFactory: MemoryFactory = () => nullMemoryAdapter;

/** Register built-in storage drivers and memory adapters. Idempotent. */
export function registerBuiltinStorage(): void {
  if (!registries.storages.has(SQLITE_DRIVER)) {
    registries.storages.register(SQLITE_DRIVER, sqliteFactory, {
      source: 'builtin',
      description: 'better-sqlite3 key/value store with WAL and TTL',
    });
  }
  if (!registries.storages.has(MEMORY_DRIVER)) {
    registries.storages.register(MEMORY_DRIVER, memoryFactory, {
      source: 'builtin',
      description: 'in-process Map store; nothing survives a restart',
    });
  }
  if (!registries.memories.has(NULL_MEMORY_ADAPTER)) {
    registries.memories.register(NULL_MEMORY_ADAPTER, nullMemoryFactory, {
      source: 'builtin',
      description: 'no long-term memory (MVP default)',
    });
  }
}

registerBuiltinStorage();

/**
 * Build the configured Storage driver. Does not call init().
 *
 * An unknown driver name degrades to the in-memory driver with a warning so a
 * config typo cannot stop the runtime from booting.
 */
export function createStorage(cfg: StorageConfig, opts: CreateStorageOptions): Storage {
  const requested = (cfg.driver ?? SQLITE_DRIVER).trim() || SQLITE_DRIVER;
  const factory = registries.storages.resolve(requested, MEMORY_DRIVER, opts.logger);
  return factory(cfg, opts);
}

/**
 * Namespaced view of a Storage. Every key is transparently prefixed with
 * `${namespace}:` and the prefix is stripped back off in query results, so two
 * scopes can never observe or clobber each other's data.
 */
export function scopeStorage(storage: Storage, namespace: string): ScopedStorage {
  const prefix = `${namespace}:`;
  const strip = (key: string): string => (key.startsWith(prefix) ? key.slice(prefix.length) : key);

  return {
    async save<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
      await storage.save<T>(prefix + key, value, ttlSeconds);
    },
    async get<T>(key: string): Promise<T | undefined> {
      return storage.get<T>(prefix + key);
    },
    async delete(key: string): Promise<void> {
      await storage.delete(prefix + key);
    },
    async query<T>(filter?: Omit<QueryFilter, 'prefix'> & { prefix?: string }): Promise<StoredRecord<T>[]> {
      const rows = await storage.query<T>({
        ...(filter ?? {}),
        prefix: `${prefix}${filter?.prefix ?? ''}`,
      });
      return rows.map((row) => ({ ...row, key: strip(row.key) }));
    },
  };
}
