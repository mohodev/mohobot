import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { createNullLogger } from '../core/logger.js';
import { CHAT_LOG_INDEX_SQL, CHAT_LOG_TABLE_SQL } from './chatlog.js';
import {
  CURRENT_SCHEMA_VERSION,
  FutureSchemaVersionError,
  MIGRATION_V1_CHECKSUM,
  MOHO_APPLICATION_ID,
  SchemaMismatchError,
  WrongApplicationIdError,
} from './migrations.js';
import { SqliteStorage } from './sqlite.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function fixture(name: string): { root: string; file: string; backups: string } {
  const root = mkdtempSync(path.join(tmpdir(), `mohobot-${name}-`)); roots.push(root);
  return { root, file: path.join(root, 'mohobot.db'), backups: path.join(root, 'data', 'backups') };
}
function legacy(file: string): Database.Database {
  const db = new Database(file);
  db.exec(`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER)`);
  db.exec('CREATE INDEX idx_kv_expires_at ON kv (expires_at)');
  db.exec(CHAT_LOG_TABLE_SQL);
  db.exec(CHAT_LOG_INDEX_SQL);
  return db;
}
function open(file: string): Database.Database { return new Database(file, { readonly: true, fileMustExist: true }); }

function storage(file: string, backups?: string): SqliteStorage {
  return new SqliteStorage({ path: file, backupDir: backups, logger: createNullLogger() });
}

describe('SQLite migration v1', () => {
  it('upgrades a populated legacy v0, preserves rows, and backfills known prefixes', async () => {
    const f = fixture('legacy');
    const db = legacy(f.file);
    db.prepare('INSERT INTO kv VALUES (?, ?, ?, NULL)').run('session:main:c:u', JSON.stringify({ messages: ['hello'] }), 10);
    db.prepare('INSERT INTO kv VALUES (?, ?, ?, NULL)').run('custom:key', JSON.stringify({ untouched: true }), 11);
    db.prepare(`INSERT INTO chat_log (channel_id,message_id,author_id,username,content,mentions_bot,bot_id,ts,created_at)
      VALUES ('c','m','u','user','hello',0,'main','2026-01-01',1)`).run();
    db.close();

    const store = storage(f.file, f.backups);
    await store.init();
    expect(await store.get('session:main:c:u')).toEqual({ messages: ['hello'] });
    await store.close();

    const current = open(f.file);
    expect(current.pragma('application_id', { simple: true })).toBe(MOHO_APPLICATION_ID);
    expect(current.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    expect(current.prepare('SELECT COUNT(*) AS n FROM chat_log').get()).toEqual({ n: 1 });
    expect(current.prepare('SELECT record_type,record_version,writer_version FROM kv WHERE key=?').get('session:main:c:u')).toEqual({ record_type: 'session', record_version: 1, writer_version: 1 });
    expect(current.prepare('SELECT record_type,record_version,writer_version FROM kv WHERE key=?').get('custom:key')).toEqual({ record_type: null, record_version: null, writer_version: null });
    expect(current.prepare('SELECT checksum FROM schema_migrations WHERE version=1').get()).toEqual({ checksum: MIGRATION_V1_CHECKSUM });
    current.close();
  });

  it('creates and verifies a restorable pre-upgrade backup', async () => {
    const f = fixture('backup');
    const db = legacy(f.file);
    db.prepare('INSERT INTO kv VALUES (?, ?, ?, NULL)').run('outbox:event-1', JSON.stringify({ eventId: 'event-1' }), 10);
    db.close();
    const store = storage(f.file, f.backups);
    await store.init(); await store.close();
    const files = readdirSync(f.backups);
    expect(files).toHaveLength(1);
    const backup = open(path.join(f.backups, files[0]!));
    expect(backup.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(backup.pragma('application_id', { simple: true })).toBe(0);
    expect(backup.pragma('user_version', { simple: true })).toBe(0);
    expect(backup.prepare('SELECT value FROM kv WHERE key=?').get('outbox:event-1')).toBeTruthy();
    expect(() => backup.prepare('SELECT * FROM schema_migrations').all()).toThrow();
    backup.close();
  });

  it('is idempotent and does not create another backup on repeated init', async () => {
    const f = fixture('repeat');
    const db = legacy(f.file); db.prepare('INSERT INTO kv VALUES (?, ?, ?, NULL)').run('session:x', '{}', 1); db.close();
    const first = storage(f.file, f.backups); await first.init(); await first.close();
    const before = readdirSync(f.backups);
    const second = storage(f.file, f.backups); await second.init(); await second.close();
    expect(readdirSync(f.backups)).toEqual(before);
    const db2 = open(f.file);
    expect(db2.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: 1 });
    db2.close();
  });

  it('initializes an empty in-memory database without backup', async () => {
    const store = new SqliteStorage({ path: ':memory:', logger: createNullLogger() });
    await store.init(); await store.save('admin-user:kim', { ok: true });
    expect(await store.get('admin-user:kim')).toEqual({ ok: true });
    await store.close();
  });

  it('rejects a database belonging to another application', async () => {
    const f = fixture('wrong-app'); const db = new Database(f.file); db.pragma('application_id = 123456'); db.close();
    await expect(storage(f.file).init()).rejects.toBeInstanceOf(WrongApplicationIdError);
  });

  it('rejects a future schema version', async () => {
    const f = fixture('future'); const db = new Database(f.file); db.pragma(`application_id = ${MOHO_APPLICATION_ID}`); db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION + 1}`); db.close();
    await expect(storage(f.file).init()).rejects.toBeInstanceOf(FutureSchemaVersionError);
  });

  it('rejects a legacy lookalike with mismatched columns before backup or mutation', async () => {
    const f = fixture('legacy-mismatch'); const db = new Database(f.file); db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value BLOB NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER)'); db.close();
    await expect(storage(f.file, f.backups).init()).rejects.toBeInstanceOf(SchemaMismatchError);
    expect(() => readdirSync(f.backups)).toThrow();
    const unchanged = open(f.file); expect(unchanged.pragma('application_id', { simple: true })).toBe(0); expect(unchanged.pragma('user_version', { simple: true })).toBe(0); unchanged.close();
  });

  it('rejects a current database whose ledger checksum is tampered', async () => {
    const f = fixture('ledger-mismatch'); const store = storage(f.file); await store.init(); await store.close();
    const db = new Database(f.file); db.prepare("UPDATE schema_migrations SET checksum='tampered' WHERE version=1").run(); db.close();
    await expect(storage(f.file).init()).rejects.toBeInstanceOf(SchemaMismatchError);
  });

  it('rejects current schema column drift even when version and application id claim v1', async () => {
    const f = fixture('column-mismatch'); const db = new Database(f.file);
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER, record_type TEXT, record_version INTEGER)');
    db.exec(CHAT_LOG_TABLE_SQL); db.exec(CHAT_LOG_INDEX_SQL); db.exec('CREATE INDEX idx_kv_expires_at ON kv(expires_at)');
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at INTEGER NOT NULL)');
    db.prepare('INSERT INTO schema_migrations VALUES (1,?,?,1)').run('baseline_typed_kv', MIGRATION_V1_CHECKSUM);
    db.pragma(`application_id = ${MOHO_APPLICATION_ID}`); db.pragma('user_version = 1'); db.close();
    await expect(storage(f.file).init()).rejects.toBeInstanceOf(SchemaMismatchError);
  });
});
