/**
 * SQLite-backed Storage.
 *
 * better-sqlite3 is a synchronous driver; every call is cheap and blocking, so
 * the async Storage surface simply wraps the sync calls. Values are stored as
 * JSON text. Expiry is enforced lazily on read plus periodically by purgeExpired().
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import type { Logger } from '../core/logger.js';
import { attachChatLogDb, detachChatLogDb } from './chatlog.js';
import { migrateSqlite, RECORD_TYPE_RULES } from './migrations.js';
import type { QueryFilter, Storage, StoredRecord } from './types.js';

type DatabaseHandle = InstanceType<typeof Database>;

interface Row {
  key: string;
  value: string;
  updated_at: number;
  expires_at: number | null;
}

export interface SqliteStorageOptions {
  /** File path, or ':memory:' for an ephemeral database. */
  path: string;
  logger: Logger;
  /** Defaults to a backups directory next to the database file. */
  backupDir?: string;
}

function recordTypeFor(key: string): string | null {
  return RECORD_TYPE_RULES.find(([prefix]) => key.startsWith(prefix))?.[1] ?? null;
}

function sanitizeCount(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const int = Math.trunc(value);
  return int < 0 ? fallback : int;
}

export class SqliteStorage implements Storage {
  readonly #path: string;
  readonly #backupDir: string | undefined;
  readonly #log: Logger;
  #db: DatabaseHandle | undefined;

  constructor(opts: SqliteStorageOptions) {
    this.#path = opts.path;
    this.#backupDir = opts.backupDir;
    this.#log = opts.logger.child({ mod: 'storage', driver: 'sqlite' });
  }

  get path(): string {
    return this.#path;
  }

  async init(): Promise<void> {
    if (this.#db !== undefined) return;
    if (this.#path !== ':memory:') {
      mkdirSync(path.dirname(path.resolve(this.#path)), { recursive: true });
    }
    const db = new Database(this.#path);
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = FULL');
      const migration = await migrateSqlite(db, { databasePath: this.#path, backupDir: this.#backupDir });
      db.pragma('synchronous = NORMAL');
      this.#db = db;
      // The physical chat log shares this database file; hand it the open handle
      // so no second connection is ever created for data/mohobot.db.
      if (this.#path !== ':memory:') attachChatLogDb(db);
      this.#log.debug({ path: this.#path, schemaVersion: migration.toVersion, migrated: migration.migrated, backupPath: migration.backupPath }, 'sqlite storage ready');
    } catch (error) {
      try { db.close(); } catch { /* preserve the migration error */ }
      throw error;
    }
  }

  async save<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const db = this.#must();
    const now = Date.now();
    const expiresAt =
      typeof ttlSeconds === 'number' && Number.isFinite(ttlSeconds) && ttlSeconds > 0
        ? now + Math.trunc(ttlSeconds * 1000)
        : null;
    const recordType = recordTypeFor(key);
    db.prepare(
      `INSERT INTO kv (key, value, updated_at, expires_at, record_type, record_version, writer_version) VALUES (?, ?, ?, ?, ?, 1, 1)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, expires_at = excluded.expires_at,
         record_type = excluded.record_type, record_version = excluded.record_version, writer_version = excluded.writer_version`,
    ).run(key, JSON.stringify(value ?? null), now, expiresAt, recordType);
  }

  async get<T>(key: string): Promise<T | undefined> {
    const db = this.#must();
    const row = db.prepare('SELECT key, value, updated_at, expires_at FROM kv WHERE key = ?').get(key) as
      | Row
      | undefined;
    if (row === undefined) return undefined;
    if (row.expires_at !== null && row.expires_at <= Date.now()) {
      db.prepare('DELETE FROM kv WHERE key = ?').run(key);
      return undefined;
    }
    return this.#decode<T>(row.key, row.value);
  }

  async delete(key: string): Promise<void> {
    this.#must().prepare('DELETE FROM kv WHERE key = ?').run(key);
  }

  async query<T>(filter: QueryFilter = {}): Promise<StoredRecord<T>[]> {
    const db = this.#must();
    const params: unknown[] = [Date.now()];
    let sql = 'SELECT key, value, updated_at, expires_at FROM kv WHERE (expires_at IS NULL OR expires_at > ?)';

    if (typeof filter.prefix === 'string' && filter.prefix.length > 0) {
      sql += " AND key LIKE ? || '%'";
      params.push(filter.prefix);
    }

    sql += ' ORDER BY updated_at DESC, key ASC LIMIT ? OFFSET ?';
    params.push(sanitizeCount(filter.limit, -1), sanitizeCount(filter.offset, 0));

    const rows = db.prepare(sql).all(...params) as Row[];
    const out: StoredRecord<T>[] = [];
    for (const row of rows) {
      const value = this.#decode<T>(row.key, row.value);
      if (value === undefined) continue;
      out.push({
        key: row.key,
        value,
        updatedAt: row.updated_at,
        ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {}),
      });
    }
    return out;
  }

  async purgeExpired(): Promise<number> {
    const info = this.#must()
      .prepare('DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?')
      .run(Date.now());
    return info.changes;
  }

  async close(): Promise<void> {
    if (this.#db === undefined) return;
    detachChatLogDb(this.#db);
    try {
      this.#db.close();
    } catch (error) {
      this.#log.warn({ error: error instanceof Error ? error.message : String(error) }, 'error closing sqlite');
    }
    this.#db = undefined;
  }

  #must(): DatabaseHandle {
    if (this.#db === undefined) throw new Error('SqliteStorage not initialised - call init() first');
    return this.#db;
  }

  /** A corrupt row is a warning, never a thrown error. */
  #decode<T>(key: string, raw: string): T | undefined {
    try {
      return JSON.parse(raw) as T;
    } catch (error) {
      this.#log.warn(
        { key, error: error instanceof Error ? error.message : String(error) },
        'skipping corrupt JSON row',
      );
      return undefined;
    }
  }
}
