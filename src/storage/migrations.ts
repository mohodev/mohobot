import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { CHAT_LOG_INDEX_SQL, CHAT_LOG_TABLE_SQL } from './chatlog.js';

type DatabaseHandle = InstanceType<typeof Database>;

/** ASCII "MOHO". This prevents accidentally opening another application's SQLite file. */
export const MOHO_APPLICATION_ID = 0x4d4f484f;
export const CURRENT_SCHEMA_VERSION = 1;
export const MIGRATION_V1_NAME = 'baseline_typed_kv';

const KV_V0_SQL = `CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER
)`;
const KV_V1_SQL = `CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER,
  record_type TEXT,
  record_version INTEGER,
  writer_version INTEGER
)`;
const LEDGER_SQL = `CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL
)`;
const KV_EXPIRY_INDEX_SQL = 'CREATE INDEX idx_kv_expires_at ON kv (expires_at)';

export const RECORD_TYPE_RULES = [
  ['session:', 'session'],
  ['message-index:', 'message-index'],
  ['thread-state:', 'thread-state'],
  ['outbox:', 'outbox-event'],
  ['admin-user:', 'admin-user'],
  ['admin-session:', 'admin-session'],
  ['admin-audit:', 'admin-audit'],
  ['plugin:', 'plugin-state'],
  ['semantic-memory:', 'semantic-memory'],
] as const;

const MIGRATION_V1_DEFINITION = JSON.stringify({
  version: 1,
  name: MIGRATION_V1_NAME,
  columns: ['record_type TEXT', 'record_version INTEGER', 'writer_version INTEGER'],
  recordTypeRules: RECORD_TYPE_RULES,
});
export const MIGRATION_V1_CHECKSUM = createHash('sha256').update(MIGRATION_V1_DEFINITION).digest('hex');

export type SqliteMigrationErrorCode =
  | 'wrong_application_id'
  | 'future_schema_version'
  | 'schema_mismatch'
  | 'backup_failed'
  | 'backup_integrity_failed'
  | 'database_integrity_failed';

export class SqliteMigrationError extends Error {
  constructor(readonly code: SqliteMigrationErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SqliteMigrationError';
  }
}
export class WrongApplicationIdError extends SqliteMigrationError {
  constructor(actual: number) { super('wrong_application_id', `SQLite application_id ${actual} does not belong to MohoBot`); this.name = 'WrongApplicationIdError'; }
}
export class FutureSchemaVersionError extends SqliteMigrationError {
  constructor(actual: number) { super('future_schema_version', `SQLite schema version ${actual} is newer than supported version ${CURRENT_SCHEMA_VERSION}`); this.name = 'FutureSchemaVersionError'; }
}
export class SchemaMismatchError extends SqliteMigrationError {
  constructor(message: string) { super('schema_mismatch', message); this.name = 'SchemaMismatchError'; }
}
export class BackupIntegrityError extends SqliteMigrationError {
  constructor(message: string, options?: { cause?: unknown }) { super('backup_integrity_failed', message, options); this.name = 'BackupIntegrityError'; }
}

export interface SqliteMigrationOptions {
  databasePath: string;
  backupDir?: string;
  now?: () => number;
}
export interface SqliteMigrationResult {
  fromVersion: number;
  toVersion: number;
  migrated: boolean;
  backupPath?: string;
}

interface ColumnInfo { name: string; type: string; notnull: 0 | 1; dflt_value: unknown; pk: number }
interface LedgerRow { version: number; name: string; checksum: string; applied_at: number }

const KV_V0_COLUMNS = [
  ['key', 'TEXT', 0, 1], ['value', 'TEXT', 1, 0], ['updated_at', 'INTEGER', 1, 0], ['expires_at', 'INTEGER', 0, 0],
] as const;
const KV_V1_COLUMNS = [
  ...KV_V0_COLUMNS,
  ['record_type', 'TEXT', 0, 0], ['record_version', 'INTEGER', 0, 0], ['writer_version', 'INTEGER', 0, 0],
] as const;
const CHAT_LOG_COLUMNS = [
  ['id', 'INTEGER', 0, 1], ['channel_id', 'TEXT', 1, 0], ['message_id', 'TEXT', 0, 0], ['author_id', 'TEXT', 0, 0],
  ['username', 'TEXT', 0, 0], ['content', 'TEXT', 0, 0], ['mentions_bot', 'INTEGER', 0, 0], ['bot_id', 'TEXT', 0, 0],
  ['ts', 'TEXT', 0, 0], ['created_at', 'INTEGER', 0, 0],
] as const;
const LEDGER_COLUMNS = [
  ['version', 'INTEGER', 0, 1], ['name', 'TEXT', 1, 0], ['checksum', 'TEXT', 1, 0], ['applied_at', 'INTEGER', 1, 0],
] as const;

/** Validate and upgrade an open SQLite database before any runtime subsystem attaches to it. */
export async function migrateSqlite(db: DatabaseHandle, options: SqliteMigrationOptions): Promise<SqliteMigrationResult> {
  const applicationId = pragmaInteger(db, 'application_id');
  const version = pragmaInteger(db, 'user_version');
  if (applicationId !== 0 && applicationId !== MOHO_APPLICATION_ID) throw new WrongApplicationIdError(applicationId);
  if (version > CURRENT_SCHEMA_VERSION) throw new FutureSchemaVersionError(version);

  if (version === CURRENT_SCHEMA_VERSION) {
    if (applicationId !== MOHO_APPLICATION_ID) throw new SchemaMismatchError('current schema is missing the MohoBot application_id');
    validateV1(db);
    quickCheck(db);
    return { fromVersion: version, toVersion: version, migrated: false };
  }
  if (version !== 0) throw new SchemaMismatchError(`unsupported SQLite schema version ${version}`);
  if (applicationId === MOHO_APPLICATION_ID) throw new SchemaMismatchError('MohoBot application_id is set but schema version is zero');

  const legacy = inspectLegacyV0(db);
  quickCheck(db);
  let backupPath: string | undefined;
  if ((legacy.hasKv || legacy.hasChatLog) && options.databasePath !== ':memory:') {
    backupPath = await createVerifiedBackup(db, options);
  }

  const appliedAt = (options.now ?? Date.now)();
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!legacy.hasKv) db.exec(KV_V0_SQL);
    if (!legacy.hasChatLog) db.exec(CHAT_LOG_TABLE_SQL.replace('IF NOT EXISTS ', ''));
    db.exec(KV_EXPIRY_INDEX_SQL.replace('INDEX ', 'INDEX IF NOT EXISTS '));
    db.exec(CHAT_LOG_INDEX_SQL);
    db.exec(LEDGER_SQL);
    db.exec('ALTER TABLE kv ADD COLUMN record_type TEXT');
    db.exec('ALTER TABLE kv ADD COLUMN record_version INTEGER');
    db.exec('ALTER TABLE kv ADD COLUMN writer_version INTEGER');
    backfillRecordMetadata(db);
    db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
      .run(1, MIGRATION_V1_NAME, MIGRATION_V1_CHECKSUM, appliedAt);
    db.pragma(`application_id = ${MOHO_APPLICATION_ID}`);
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
    validateV1(db);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve the migration failure */ }
    if (error instanceof SqliteMigrationError) throw error;
    throw new SchemaMismatchError(`SQLite migration v1 failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  quickCheck(db);
  return { fromVersion: 0, toVersion: CURRENT_SCHEMA_VERSION, migrated: true, ...(backupPath ? { backupPath } : {}) };
}

function inspectLegacyV0(db: DatabaseHandle): { hasKv: boolean; hasChatLog: boolean; hasData: boolean } {
  const tables = userTables(db);
  const allowed = new Set(['kv', 'chat_log']);
  const unexpected = tables.filter((table) => !allowed.has(table));
  if (unexpected.length) throw new SchemaMismatchError(`legacy SQLite schema contains unexpected tables: ${unexpected.join(', ')}`);
  const hasKv = tables.includes('kv');
  const hasChatLog = tables.includes('chat_log');
  if (hasKv) assertColumns(db, 'kv', KV_V0_COLUMNS);
  if (hasChatLog) assertColumns(db, 'chat_log', CHAT_LOG_COLUMNS);
  if (indexExists(db, 'idx_kv_expires_at') && !hasKv) throw new SchemaMismatchError('legacy SQLite has kv expiry index without kv table');
  if (indexExists(db, 'idx_chat_log_channel_ts') && !hasChatLog) throw new SchemaMismatchError('legacy SQLite has chat log index without chat_log table');
  const hasData = (hasKv && rowCount(db, 'kv') > 0) || (hasChatLog && rowCount(db, 'chat_log') > 0);
  return { hasKv, hasChatLog, hasData };
}

function validateV1(db: DatabaseHandle): void {
  const tables = userTables(db);
  for (const required of ['kv', 'chat_log', 'schema_migrations']) {
    if (!tables.includes(required)) throw new SchemaMismatchError(`current SQLite schema is missing table ${required}`);
  }
  const unexpected = tables.filter((table) => !['kv', 'chat_log', 'schema_migrations'].includes(table));
  if (unexpected.length) throw new SchemaMismatchError(`current SQLite schema contains unexpected tables: ${unexpected.join(', ')}`);
  assertColumns(db, 'kv', KV_V1_COLUMNS);
  assertColumns(db, 'chat_log', CHAT_LOG_COLUMNS);
  assertColumns(db, 'schema_migrations', LEDGER_COLUMNS);
  if (!indexExists(db, 'idx_kv_expires_at') || !indexExists(db, 'idx_chat_log_channel_ts')) {
    throw new SchemaMismatchError('current SQLite schema is missing required indexes');
  }
  const rows = db.prepare('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version').all() as LedgerRow[];
  if (rows.length !== 1 || rows[0]?.version !== 1 || rows[0].name !== MIGRATION_V1_NAME || rows[0].checksum !== MIGRATION_V1_CHECKSUM) {
    throw new SchemaMismatchError('schema_migrations ledger does not match migration v1');
  }
}

async function createVerifiedBackup(db: DatabaseHandle, options: SqliteMigrationOptions): Promise<string> {
  const source = path.resolve(options.databasePath);
  if (!existsSync(source)) throw new SqliteMigrationError('backup_failed', 'cannot back up a missing SQLite database file');
  const backupDir = path.resolve(options.backupDir ?? path.join(path.dirname(source), 'backups'));
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date((options.now ?? Date.now)()).toISOString().replace(/[:.]/g, '-');
  const parsed = path.parse(source);
  let destination = path.join(backupDir, `${parsed.name}.v0.${stamp}.sqlite`);
  let suffix = 1;
  while (existsSync(destination)) destination = path.join(backupDir, `${parsed.name}.v0.${stamp}.${suffix++}.sqlite`);
  try {
    await db.backup(destination);
  } catch (error) {
    throw new SqliteMigrationError('backup_failed', 'SQLite backup failed before migration', { cause: error });
  }
  let backup: DatabaseHandle | undefined;
  try {
    backup = new Database(destination, { fileMustExist: true });
    integrityCheck(backup, 'integrity_check', 'backup_integrity_failed');
    inspectLegacyV0(backup);
    if (pragmaInteger(backup, 'application_id') !== 0 || pragmaInteger(backup, 'user_version') !== 0) {
      throw new BackupIntegrityError('SQLite backup is not a legacy v0 snapshot');
    }
    // A standalone recovery artifact must not depend on lingering WAL/SHM sidecars.
    backup.pragma('wal_checkpoint(TRUNCATE)');
    backup.pragma('journal_mode = DELETE');
  } catch (error) {
    if (error instanceof BackupIntegrityError) throw error;
    throw new BackupIntegrityError('SQLite backup validation failed', { cause: error });
  } finally {
    try { backup?.close(); } catch { /* validation error is more useful */ }
  }
  return destination;
}

function backfillRecordMetadata(db: DatabaseHandle): void {
  const statement = db.prepare(`UPDATE kv SET record_type = ?, record_version = 1, writer_version = 1
    WHERE record_type IS NULL AND key LIKE ? ESCAPE '\\'`);
  for (const [prefix, recordType] of RECORD_TYPE_RULES) statement.run(recordType, `${escapeLike(prefix)}%`);
}
function escapeLike(value: string): string { return value.replace(/[\\%_]/g, (match) => `\\${match}`); }

function pragmaInteger(db: DatabaseHandle, name: 'application_id' | 'user_version'): number {
  const row = db.pragma(name, { simple: true });
  return typeof row === 'number' ? row : Number(row);
}
function quickCheck(db: DatabaseHandle): void { integrityCheck(db, 'quick_check', 'database_integrity_failed'); }
function integrityCheck(db: DatabaseHandle, pragma: 'quick_check' | 'integrity_check', code: 'database_integrity_failed' | 'backup_integrity_failed'): void {
  const rows = db.pragma(pragma) as Array<Record<string, unknown>>;
  const values = rows.flatMap((row) => Object.values(row)).map(String);
  if (values.length !== 1 || values[0] !== 'ok') {
    const message = `SQLite ${pragma} failed: ${values.join('; ') || 'no result'}`;
    if (code === 'backup_integrity_failed') throw new BackupIntegrityError(message);
    throw new SqliteMigrationError(code, message);
  }
}
function userTables(db: DatabaseHandle): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
}
function indexExists(db: DatabaseHandle, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(name));
}
function rowCount(db: DatabaseHandle, table: 'kv' | 'chat_log'): number {
  return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
}
function assertColumns(db: DatabaseHandle, table: string, expected: readonly (readonly [string, string, number, number])[]): void {
  const actual = db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as ColumnInfo[];
  const normalized = actual.map((column) => [column.name, column.type.toUpperCase(), column.notnull, column.pk] as const);
  if (JSON.stringify(normalized) !== JSON.stringify(expected)) {
    throw new SchemaMismatchError(`table ${table} columns do not match the expected schema`);
  }
}

export const SQLITE_V1_SCHEMA_SQL = { KV_V1_SQL, LEDGER_SQL } as const;
