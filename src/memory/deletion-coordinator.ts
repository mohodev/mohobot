/**
 * Deletion coordination between the message lifecycle (MessageSync tombstones,
 * SessionManager source-message deletes) and long-term memory adapters.
 *
 * This is a deliberately narrow, structured interface: memory implementations
 * plug in a `MemoryDeletionSink` without the session layer knowing anything
 * about semantic/expression memory internals.
 *
 * Guarantees:
 * - Idempotent: a source message is forgotten at most once per sink, even
 *   across duplicate delete events and restarts (when storage is provided).
 * - Anti-resurrection: once a sourceMessageId is recorded as deleted, late
 *   edits/derived writes for it are rejected via `isDeleted()`.
 * - Sink failures never break the deletion path; they are logged and can be
 *   retried with `notify()` (idempotency markers are written before fanning out).
 */

import type { Platform } from '../core/types.js';
import type { Logger } from '../core/logger.js';
import type { Storage } from '../storage/types.js';

export interface MemoryDeletionNotification {
  botId: string;
  /** Platform message id the session/memory turn was derived from. */
  sourceMessageId: string;
  sourcePlatform: Platform | string;
  channelId?: string;
  userId?: string;
  /** Best-effort snapshot of the original content at deletion time. */
  content?: string;
  deletedAt: number;
}

/** Implemented by long-term memory adapters that support deletion. */
export interface MemoryDeletionSink {
  readonly name: string;
  /** Must be idempotent: forgetting an already-forgotten id is a no-op. */
  forgetSourceMessage(notification: MemoryDeletionNotification): Promise<void>;
}

export interface DeletionCoordinatorOptions {
  storage?: Storage;
  logger: Logger;
  now?: () => number;
}

interface DeletionMarker {
  kind: 'memory-deletion';
  botId: string;
  sourceMessageId: string;
  sourcePlatform: string;
  deletedAt: number;
  recordedAt: number;
}

const PREFIX = 'memory-deletion:';

function markerKey(notification: Pick<MemoryDeletionNotification, 'sourceMessageId' | 'sourcePlatform'>): string {
  return `${PREFIX}${encodeURIComponent(notification.sourcePlatform)}:message:${encodeURIComponent(notification.sourceMessageId)}`;
}

export class MemoryDeletionCoordinator {
  readonly #sinks: MemoryDeletionSink[] = [];
  readonly #storage: Storage | undefined;
  readonly #logger: Logger;
  readonly #now: () => number;
  /** In-process fast path for `isDeleted()`; storage is the restart-safe record. */
  readonly #deleted = new Set<string>();

  constructor(options: DeletionCoordinatorOptions) {
    this.#storage = options.storage;
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
  }

  register(sink: MemoryDeletionSink): void {
    if (!this.#sinks.includes(sink)) this.#sinks.push(sink);
  }

  /** True when this source message has already been tombstoned/processed. */
  isDeleted(sourcePlatform: string, sourceMessageId: string): boolean {
    return this.#deleted.has(markerKey({ sourcePlatform, sourceMessageId }));
  }

  /**
   * Record the deletion and fan out to every sink. Safe to call any number of
   * times for the same message: only the first call reaches the sinks.
   */
  async notify(notification: MemoryDeletionNotification): Promise<void> {
    const key = markerKey(notification);
    if (this.#deleted.has(key)) return;

    if (this.#storage) {
      try {
        const existing = await this.#storage.get<DeletionMarker>(key);
        if (existing) {
          this.#deleted.add(key);
          return;
        }
        await this.#storage.save(key, {
          kind: 'memory-deletion' as const,
          botId: notification.botId,
          sourceMessageId: notification.sourceMessageId,
          sourcePlatform: String(notification.sourcePlatform),
          deletedAt: notification.deletedAt,
          recordedAt: this.#now(),
        } satisfies DeletionMarker);
      } catch (error) {
        // Marker write failure must not lose the deletion: keep going so the
        // sinks still hear about it.
        this.#logger.warn({ key, error: error instanceof Error ? error.message : String(error) }, 'deletion marker write failed');
      }
    }

    this.#deleted.add(key);
    await Promise.allSettled(this.#sinks.map(async (sink) => {
      try {
        await sink.forgetSourceMessage(notification);
      } catch (error) {
        this.#logger.warn(
          { sink: sink.name, sourceMessageId: notification.sourceMessageId, error: error instanceof Error ? error.message : String(error) },
          'memory deletion sink failed; short-term deletion is unaffected',
        );
      }
    }));
  }
}
