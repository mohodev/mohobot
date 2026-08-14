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
import { SemanticMemoryAdapter } from '../memory/semantic-memory.js';

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
export const SEMANTIC_MEMORY_ADAPTER = 'semantic';

const sqliteFactory: StorageFactory = (cfg, deps) => {
  const raw = typeof cfg.path === 'string' && cfg.path.trim().length > 0 ? cfg.path.trim() : './data/mohobot.db';
  const resolved = raw === ':memory:' || path.isAbsolute(raw) ? raw : path.resolve(deps.rootDir, raw);
  const configuredBackupDir = typeof cfg.options['backupDir'] === 'string' ? cfg.options['backupDir'].trim() : '';
  const backupDir = configuredBackupDir
    ? (path.isAbsolute(configuredBackupDir) ? configuredBackupDir : path.resolve(deps.rootDir, configuredBackupDir))
    : undefined;
  return new SqliteStorage({ path: resolved, logger: deps.logger, backupDir });
};
const memoryFactory: StorageFactory = (_cfg, deps) => new MemoryStorage({ logger: deps.logger });
const nullMemoryFactory: MemoryFactory = () => nullMemoryAdapter;
const semanticMemoryFactory: MemoryFactory = (deps) => {
  if (!deps.storage) throw new Error('semantic memory requires a storage driver');
  const recallLimit = typeof deps.options['recallLimit'] === 'number' ? deps.options['recallLimit'] : undefined;
  const candidateLimit = typeof deps.options['candidateLimit'] === 'number' ? deps.options['candidateLimit'] : undefined;
  const embeddingBatchSize = typeof deps.options['embeddingBatchSize'] === 'number' ? deps.options['embeddingBatchSize'] : undefined;
  const configuredDomains=deps.options['channelDomains'];const channelDomains=configuredDomains&&typeof configuredDomains==='object'&&!Array.isArray(configuredDomains)?configuredDomains as Record<string,unknown>:{};
  const channelDomain=(channelId:string)=>typeof channelDomains[channelId]==='string'&&String(channelDomains[channelId]).trim()?String(channelDomains[channelId]).trim():`channel:${channelId}`;
  const configuredScopes=deps.options['allowedScopes'];const safeScopes=Array.isArray(configuredScopes)?configuredScopes.filter((scope):scope is 'private'|'relationship'|'shared'=>scope==='private'||scope==='relationship'||scope==='shared'):undefined;
  const allowedScopes=safeScopes?()=>safeScopes:undefined;
  return new SemanticMemoryAdapter({ storage: deps.storage, logger: deps.logger, recallLimit, candidateLimit, embeddingBatchSize,channelDomain,allowedScopes });
};

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
  if (!registries.memories.has(SEMANTIC_MEMORY_ADAPTER)) {
    registries.memories.register(SEMANTIC_MEMORY_ADAPTER, semanticMemoryFactory, {
      source: 'builtin',
      description: 'storage-backed semantic memory with optional derived vectors',
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
