/**
 * MemoryDeletionSink adapter for Expression Memory.
 *
 * When a source message is deleted, this sink finds all expression memory
 * records derived from that message and tombstones them via the governance
 * layer. Best-effort: failures are logged but never thrown.
 */

import type { Logger } from '../core/logger.js';
import type { MemoryDeletionNotification, MemoryDeletionSink } from './deletion-coordinator.js';
import { ExpressionMemoryGovernance } from './expression-memory-governance.js';
import { EXPRESSION_MEMORY_PREFIX, validRecord } from './expression-memory.js';
import type { ExpressionMemoryRecord } from './expression-memory.js';
import type { Storage } from '../storage/types.js';

export interface ExpressionDeletionSinkOptions {
  storage: Storage;
  logger: Logger;
}

export class ExpressionDeletionSink implements MemoryDeletionSink {
  readonly name = 'expression-memory';
  readonly #governance: ExpressionMemoryGovernance;
  readonly #storage: Storage;
  readonly #logger: Logger;

  constructor(options: ExpressionDeletionSinkOptions) {
    this.#storage = options.storage;
    this.#logger = options.logger.child({ component: 'expression-deletion-sink' });
    this.#governance = new ExpressionMemoryGovernance({
      storage: options.storage,
      logger: options.logger,
    });
  }

  async forgetSourceMessage(notification: MemoryDeletionNotification): Promise<void> {
    const { botId, sourceMessageId } = notification;
    // Expression memory records are keyed as `expression-memory:<botId>:<userId>:<id>`.
    // We need to scan by botId prefix since the deleted message may belong to
    // any user. The userId from the notification helps narrow the search.
    const prefix = notification.userId
      ? `${EXPRESSION_MEMORY_PREFIX}${botId}:${notification.userId}:`
      : `${EXPRESSION_MEMORY_PREFIX}${botId}:`;
    let rows: Array<{ key: string; value: unknown }>;
    try {
      rows = await this.#storage.query<unknown>({ prefix, limit: 1000 });
    } catch (error) {
      this.#logger.warn(
        { botId, sourceMessageId, error: error instanceof Error ? error.message : String(error) },
        'expression deletion sink query failed',
      );
      return;
    }

    let tombstoned = 0;
    for (const row of rows) {
      if (!validRecord(row.value)) continue;
      const record = row.value as ExpressionMemoryRecord;
      if (record.sourceMessageId !== sourceMessageId) continue;
      if (record.tombstone !== undefined) continue;
      try {
        const outcome = await this.#governance.tombstone(
          record.botId,
          record.userId,
          record.id,
          'deletion-coordinator',
          `source message ${sourceMessageId} deleted`,
        );
        if (outcome === 'applied') tombstoned += 1;
      } catch (error) {
        this.#logger.warn(
          { botId, userId: record.userId, id: record.id, error: error instanceof Error ? error.message : String(error) },
          'expression memory tombstone failed during source deletion',
        );
      }
    }
    if (tombstoned > 0) {
      this.#logger.info({ botId, sourceMessageId, tombstoned }, 'expression memories tombstoned for deleted source message');
    }
  }
}
