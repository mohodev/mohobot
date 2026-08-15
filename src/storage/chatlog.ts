/**
 * SQLite-backed physical chat log.
 *
 * Lives in the SAME database file as the kv store (data/mohobot.db) so the
 * runtime has exactly one storage engine. SqliteStorage.init() attaches its
 * open handle here (see attachChatLogDb) so no second connection is created in
 * the running bot; standalone scripts that never build a SqliteStorage fall
 * back to lazily opening the default database path themselves.
 *
 * better-sqlite3 is synchronous: every function below is sync and cheap.
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

type DatabaseHandle = InstanceType<typeof Database>;

/** One inbound message as handed to chatLogInsert(). */
export interface ChatLogInsert {
  channelId: string;
  messageId: string;
  authorId: string;
  username: string;
  content: string;
  mentionsBot: boolean;
  botId: string;
  /** ISO timestamp; defaults to now. */
  ts?: string;
  /** Epoch millis; defaults to now. */
  createdAt?: number;
}

/** One row as stored / returned by chatLogQuery(). */
export interface ChatLogRow {
  id: number;
  channel_id: string;
  message_id: string;
  author_id: string;
  username: string;
  content: string;
  mentions_bot: number;
  bot_id: string;
  ts: string;
  created_at: number;
}

export const CHAT_LOG_TABLE_SQL = `CREATE TABLE IF NOT EXISTS chat_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  author_id TEXT,
  username TEXT,
  content TEXT,
  mentions_bot INTEGER,
  bot_id TEXT,
  ts TEXT,
  created_at INTEGER
)`;

export const CHAT_LOG_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS idx_chat_log_channel_ts ON chat_log (channel_id, ts)';

const INSERT_SQL = `INSERT INTO chat_log
  (channel_id, message_id, author_id, username, content, mentions_bot, bot_id, ts, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const QUERY_SQL = `SELECT id, channel_id, message_id, author_id, username, content, mentions_bot, bot_id, ts, created_at
  FROM chat_log WHERE channel_id = ? ORDER BY id DESC LIMIT ?`;
const QUERY_BOT_SQL = `SELECT id, channel_id, message_id, author_id, username, content, mentions_bot, bot_id, ts, created_at
  FROM chat_log WHERE channel_id = ? AND bot_id = ? ORDER BY id DESC LIMIT ?`;

/** Create the chat_log table + index on an already-open database. Idempotent. */
export function ensureChatLogSchema(db: DatabaseHandle): void {
  db.exec(CHAT_LOG_TABLE_SQL);
  db.exec(CHAT_LOG_INDEX_SQL);
}

/** Default database file - identical to the sqlite storage driver default. */
export function defaultChatLogPath(): string {
  const root = process.env.MOHO_ROOT ?? process.cwd();
  return path.resolve(root, 'data', 'mohobot.db');
}

/** Handle donated by SqliteStorage; preferred over the fallback below. */
let attached: DatabaseHandle | undefined;
/** Fallback handle this module opened itself (scripts, tests, early boot). */
let owned: DatabaseHandle | undefined;

/** Share an open database with the chat log. Called by SqliteStorage.init(). */
export function attachChatLogDb(db: DatabaseHandle): void {
  ensureChatLogSchema(db);
  attached = db;
}

/** Drop a shared handle before it is closed. Called by SqliteStorage.close(). */
export function detachChatLogDb(db?: DatabaseHandle): void {
  if (db === undefined || attached === db) attached = undefined;
}

function resolveDb(): DatabaseHandle {
  if (attached !== undefined) return attached;
  if (owned !== undefined) return owned;
  const file = defaultChatLogPath();
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  ensureChatLogSchema(db);
  owned = db;
  return db;
}

/** Append one message. Synchronous; throws only on a real database error. */
export function chatLogInsert(row: ChatLogInsert): void {
  const db = resolveDb();
  const now = Date.now();
  db.prepare(INSERT_SQL).run(
    row.channelId,
    row.messageId,
    row.authorId,
    row.username,
    row.content,
    row.mentionsBot ? 1 : 0,
    row.botId,
    row.ts ?? new Date(now).toISOString(),
    typeof row.createdAt === 'number' && Number.isFinite(row.createdAt) ? Math.trunc(row.createdAt) : now,
  );
}

/** Most recent messages of a channel, newest first. */
export function chatLogQuery(channelId: string, limit = 50, botId?: string): ChatLogRow[] {
  const db = resolveDb();
  const n = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 50;
  return (botId ? db.prepare(QUERY_BOT_SQL).all(channelId, botId, n) : db.prepare(QUERY_SQL).all(channelId, n)) as ChatLogRow[];
}

/** Close only a handle this module opened itself. */
export function closeChatLogDb(): void {
  if (owned === undefined) return;
  try {
    owned.close();
  } catch {
    /* closing twice is not an error worth propagating */
  }
  owned = undefined;
}
