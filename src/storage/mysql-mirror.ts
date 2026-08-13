import type { Logger } from '../core/logger.js';
import type { OutboxEvent } from './outbox.js';
import type { RemoteMirror } from './outbox-worker.js';

/** Minimal mysql2-compatible surface. The runtime does not depend on mysql2. */
export interface MySqlClientLike {
  execute(sql: string, params?: readonly unknown[]): Promise<unknown>;
}

export interface MySqlMirrorOptions {
  table?: string;
  logger: Logger;
}

export interface MySqlMirrorHealth {
  ok: boolean;
  /** Safe operational detail only. Driver errors and connection data are omitted. */
  detail?: 'ready' | 'unavailable';
}

const DEFAULT_TABLE = 'mohobot_outbox_events';
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function tableName(value: string | undefined): string {
  const table = value?.trim() || DEFAULT_TABLE;
  if (!IDENTIFIER.test(table)) throw new Error('invalid MySQL mirror table name');
  return table;
}

function safeJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('outbox payload is not JSON serializable');
  return serialized;
}

/**
 * Optional MySQL sink for the local Outbox worker.
 *
 * `event_id` is the idempotency key. Duplicate delivery intentionally keeps
 * the first committed event unchanged instead of overwriting remote history.
 * This class never receives, stores, or logs a database URL or credential.
 */
export class MySqlRemoteMirror implements RemoteMirror {
  readonly #client: MySqlClientLike;
  readonly #logger: Logger;
  readonly #table: string;

  constructor(client: MySqlClientLike, options: MySqlMirrorOptions) {
    this.#client = client;
    this.#logger = options.logger.child({ component: 'mysql-mirror' });
    this.#table = tableName(options.table);
  }

  /** Create the remote idempotency table. Safe to call on every startup. */
  async init(): Promise<void> {
    const sql = `CREATE TABLE IF NOT EXISTS \`${this.#table}\` (
      event_id VARCHAR(191) NOT NULL,
      event_type VARCHAR(191) NOT NULL,
      payload_json JSON NOT NULL,
      source_created_at BIGINT NOT NULL,
      source_updated_at BIGINT NOT NULL,
      source_attempts INT UNSIGNED NOT NULL,
      mirrored_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (event_id),
      KEY idx_event_type_created (event_type, source_created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;
    try {
      await this.#client.execute(sql);
    } catch {
      this.#logger.warn({}, 'MySQL mirror schema initialization failed');
      throw new Error('MySQL mirror initialization failed');
    }
  }

  async send(event: OutboxEvent): Promise<void> {
    const sql = `INSERT INTO \`${this.#table}\`
      (event_id, event_type, payload_json, source_created_at, source_updated_at, source_attempts)
      VALUES (?, ?, CAST(? AS JSON), ?, ?, ?)
      ON DUPLICATE KEY UPDATE event_id = VALUES(event_id)`;
    const params = [
      event.eventId,
      event.type,
      safeJson(event.payload),
      event.createdAt,
      event.updatedAt,
      event.attempts,
    ] as const;
    try {
      await this.#client.execute(sql, params);
    } catch {
      this.#logger.warn({ eventId: event.eventId, eventType: event.type }, 'MySQL mirror delivery failed');
      // The Outbox stores this error. Keep it deliberately free of driver
      // details because driver messages may contain usernames or host URLs.
      throw new Error('MySQL mirror delivery failed');
    }
  }

  async health(): Promise<MySqlMirrorHealth> {
    try {
      await this.#client.execute('SELECT 1 AS ok');
      return { ok: true, detail: 'ready' };
    } catch {
      this.#logger.debug({}, 'MySQL mirror health check failed');
      return { ok: false, detail: 'unavailable' };
    }
  }
}
