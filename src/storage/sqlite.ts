/**
 * SQLite-backed Storage.
 *
 * better-sqlite3 is a synchronous driver; every call is cheap and blocking, so
 * the async Storage surface simply wraps the sync calls. Values are stored as
 * JSON text. Expiry is enforced lazily on read plus periodically by purgeExpired().
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import type { Logger } from '../core/logger.js';
import { attachChatLogDb, detachChatLogDb } from './chatlog.js';
import { migrateSqlite } from './migrations.js';
import type { AtomicOutboxStorage, ClaimOptions, OutboxEvent, ReleaseOptions } from './outbox.js';
import {
  CURRENT_RECORD_VERSION, CURRENT_WRITER_VERSION, expectedRecordType,
  RecordMetadataError, validateRecordMetadata,
} from './record-codec.js';
import type { QueryFilter, Storage, StoredRecord } from './types.js';

type DatabaseHandle = InstanceType<typeof Database>;

interface Row {
  key: string;
  value: string;
  updated_at: number;
  expires_at: number | null;
  record_type: string | null;
  record_version: number | null;
  writer_version: number | null;
}

const OUTBOX_PREFIX = 'outbox:';
const MAX_OUTBOX_ERROR_LENGTH = 2_000;

export interface SqliteStorageOptions {
  /** File path, or ':memory:' for an ephemeral database. */
  path: string;
  logger: Logger;
  /** Defaults to a backups directory next to the database file. */
  backupDir?: string;
}

function sanitizeCount(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const int = Math.trunc(value);
  return int < 0 ? fallback : int;
}

export class SqliteStorage implements Storage, AtomicOutboxStorage {
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
    const existing = db.prepare(
      'SELECT record_type, record_version, writer_version FROM kv WHERE key = ?',
    ).get(key) as Pick<Row, 'record_type'|'record_version'|'writer_version'> | undefined;
    if (existing) {
      validateRecordMetadata(key, {
        recordType: existing.record_type,
        recordVersion: existing.record_version,
        writerVersion: existing.writer_version,
      });
    }
    const recordType = expectedRecordType(key);
    db.prepare(
      `INSERT INTO kv (key, value, updated_at, expires_at, record_type, record_version, writer_version) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, expires_at = excluded.expires_at,
         record_type = excluded.record_type, record_version = excluded.record_version, writer_version = excluded.writer_version`,
    ).run(key, JSON.stringify(value ?? null), now, expiresAt, recordType,
      recordType === null ? null : CURRENT_RECORD_VERSION,
      recordType === null ? null : CURRENT_WRITER_VERSION);
  }

  async get<T>(key: string): Promise<T | undefined> {
    const db = this.#must();
    const row = db.prepare('SELECT key, value, updated_at, expires_at, record_type, record_version, writer_version FROM kv WHERE key = ?').get(key) as
      | Row
      | undefined;
    if (row === undefined) return undefined;
    if (row.expires_at !== null && row.expires_at <= Date.now()) {
      db.prepare('DELETE FROM kv WHERE key = ?').run(key);
      return undefined;
    }
    return this.#decode<T>(row);
  }

  async delete(key: string): Promise<void> {
    this.#must().prepare('DELETE FROM kv WHERE key = ?').run(key);
  }

  async query<T>(filter: QueryFilter = {}): Promise<StoredRecord<T>[]> {
    const db = this.#must();
    const params: unknown[] = [Date.now()];
    let sql = 'SELECT key, value, updated_at, expires_at, record_type, record_version, writer_version FROM kv WHERE (expires_at IS NULL OR expires_at > ?)';

    if (typeof filter.prefix === 'string' && filter.prefix.length > 0) {
      sql += " AND key LIKE ? || '%'";
      params.push(filter.prefix);
    }

    sql += ' ORDER BY updated_at DESC, key ASC LIMIT ? OFFSET ?';
    params.push(sanitizeCount(filter.limit, -1), sanitizeCount(filter.offset, 0));

    const rows = db.prepare(sql).all(...params) as Row[];
    const out: StoredRecord<T>[] = [];
    for (const row of rows) {
      const value = this.#decode<T>(row);
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

  async claimOutboxAtomic<T = unknown>(workerId: string, options: Required<ClaimOptions>): Promise<OutboxEvent<T>[]> {
    const db = this.#must();
    const run = db.transaction(() => {
      this.#recoverExpiredOutbox(db, options.now);
      const rows = db.prepare(
        `SELECT key, value FROM kv
         WHERE key LIKE ? || '%' AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY updated_at ASC, key ASC`,
      ).all(OUTBOX_PREFIX, options.now) as Array<Pick<Row, 'key' | 'value'>>;
      const candidates = rows
        .map((row) => ({ row, event: this.#decodeOutbox<T>(row.key, row.value) }))
        .filter((entry): entry is { row: Pick<Row, 'key' | 'value'>; event: OutboxEvent<T> } => entry.event !== undefined)
        .filter(({ event }) => (event.status === 'pending' || event.status === 'failed') && event.nextAttemptAt <= options.now)
        .sort((a, b) => (a.event.createdAt - b.event.createdAt) || a.event.eventId.localeCompare(b.event.eventId))
        .slice(0, options.limit);
      const claimed: OutboxEvent<T>[] = [];
      const update = db.prepare(
        `UPDATE kv SET value = ?, updated_at = ?, record_type = 'outbox-event', record_version = 1, writer_version = 1
         WHERE key = ? AND value = ?`,
      );
      for (const { row, event } of candidates) {
        const next: OutboxEvent<T> = {
          ...event,
          status: 'processing',
          attempts: Math.max(0, Math.floor(event.attempts)) + 1,
          updatedAt: options.now,
          workerId,
          claimToken: randomUUID(),
          claimExpiresAt: options.now + options.leaseMs,
        };
        if (update.run(JSON.stringify(next), options.now, row.key, row.value).changes === 1) claimed.push(next);
      }
      return claimed;
    });
    return run.immediate();
  }

  async releaseOutboxAtomic(eventId: string, workerId: string, options: ReleaseOptions & { now: number }): Promise<OutboxEvent | undefined> {
    const db = this.#must();
    const key = `${OUTBOX_PREFIX}${eventId}`;
    const run = db.transaction(() => {
      const row = db.prepare('SELECT key, value, updated_at, expires_at FROM kv WHERE key = ?').get(key) as Row | undefined;
      if (!row) return undefined;
      const current = this.#decodeOutbox(row.key, row.value);
      if (!current) return undefined;
      if (current.status !== 'processing' || current.workerId !== workerId || current.claimToken !== options.claimToken) return current;
      const done = options.done === true;
      const next: OutboxEvent = {
        ...current,
        status: done ? 'done' : 'failed',
        updatedAt: options.now,
        nextAttemptAt: done ? options.now : options.now + Math.max(0, options.retryAfterMs ?? 0),
        workerId: undefined,
        claimToken: undefined,
        claimExpiresAt: undefined,
        ...(done
          ? { lastError: undefined }
          : options.error ? { lastError: options.error.slice(0, MAX_OUTBOX_ERROR_LENGTH) } : {}),
      };
      const changed = db.prepare('UPDATE kv SET value = ?, updated_at = ? WHERE key = ? AND value = ?')
        .run(JSON.stringify(next), options.now, key, row.value).changes;
      return changed === 1 ? next : this.#decodeOutbox(key, (db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string }).value);
    });
    return run.immediate();
  }

  async recoverExpiredOutboxAtomic(now: number): Promise<number> {
    return this.#must().transaction(() => this.#recoverExpiredOutbox(this.#must(), now)).immediate();
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

  #recoverExpiredOutbox(db: DatabaseHandle, now: number): number {
    const rows = db.prepare("SELECT key, value FROM kv WHERE key LIKE ? || '%'").all(OUTBOX_PREFIX) as Array<Pick<Row, 'key' | 'value'>>;
    const update = db.prepare('UPDATE kv SET value = ?, updated_at = ? WHERE key = ? AND value = ?');
    let recovered = 0;
    for (const row of rows) {
      const event = this.#decodeOutbox(row.key, row.value);
      if (!event || event.status !== 'processing' || event.claimExpiresAt === undefined || event.claimExpiresAt > now) continue;
      const next: OutboxEvent = {
        ...event,
        status: 'pending',
        updatedAt: now,
        nextAttemptAt: now,
        workerId: undefined,
        claimToken: undefined,
        claimExpiresAt: undefined,
      };
      recovered += update.run(JSON.stringify(next), now, row.key, row.value).changes;
    }
    return recovered;
  }

  #decodeOutbox<T = unknown>(key: string, raw: string): OutboxEvent<T> | undefined {
    const value = this.#decode<OutboxEvent<T>>({key,value:raw,updated_at:0,expires_at:null,record_type:'outbox-event',record_version:CURRENT_RECORD_VERSION,writer_version:CURRENT_WRITER_VERSION});
    if (!value || typeof value !== 'object' || typeof value.eventId !== 'string' || typeof value.status !== 'string') {
      this.#log.warn({ key }, 'skipping invalid outbox row');
      return undefined;
    }
    return value;
  }

  /** Corrupt, mismatched, or future rows are skipped instead of reaching old business code. */
  #decode<T>(row: Row): T | undefined {
    try {
      validateRecordMetadata(row.key, {
        recordType: row.record_type,
        recordVersion: row.record_version,
        writerVersion: row.writer_version,
      });
      return JSON.parse(row.value) as T;
    } catch (error) {
      this.#log.warn(
        {
          key: row.key,
          code: error instanceof RecordMetadataError ? error.code : 'corrupt_json',
          error: error instanceof Error ? error.message : String(error),
        },
        'skipping unreadable KV row',
      );
      return undefined;
    }
  }
}
