import type { Logger } from '../core/logger.js';
import {
  EXPRESSION_MEMORY_PREFIX, SENSITIVE, isPromptInjectionLike, validRecord,
} from './expression-memory.js';
import type { ExpressionCategory, ExpressionMemoryRecord, ExpressionStatus } from './expression-memory.js';
import type { Storage } from '../storage/types.js';

export type ExpressionGovernanceOutcome = 'applied' | 'unchanged' | 'not-found' | 'invalid';

export interface ExpressionReplacement {
  category?: ExpressionCategory;
  text: string;
}

export interface BulkDeleteFilter {
  botId: string;
  userId?: string;
  channelId?: string;
  before?: number;
}

export interface ExportOptions {
  /** Filter by status. */
  status?: ExpressionStatus;
  /** Maximum records to export. */
  limit?: number;
}

/** A single sanitized record for JSONL export (no raw user/channel IDs). */
export interface SanitizedExpressionRecord {
  id: string;
  category: ExpressionCategory;
  text: string;
  normalized: string;
  status: ExpressionStatus;
  confidence: number;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  sourcePlatform?: string;
  reviewer?: string;
  tombstone?: { at: number; reason?: string };
}

export interface ExpressionMemoryGovernanceOptions {
  storage: Storage;
  logger: Logger;
  now?: () => number;
}

const MAX_TEXT = 120;

/**
 * Narrow, explicit review surface over stored expression-memory records.
 * All transitions are idempotent: replaying the same call returns 'unchanged'.
 */
export class ExpressionMemoryGovernance {
  readonly #storage: Storage;
  readonly #logger: Logger;
  readonly #now: () => number;

  constructor(options: ExpressionMemoryGovernanceOptions) {
    this.#storage = options.storage;
    this.#logger = options.logger.child({ component: 'expression-memory-governance' });
    this.#now = options.now ?? Date.now;
  }

  async approve(botId: string, userId: string, id: string, reviewer: string): Promise<ExpressionGovernanceOutcome> {
    return this.#transition(botId, userId, id, reviewer, (record) => {
      if (record.tombstone !== undefined) return undefined;
      if (record.status === 'approved') return undefined;
      return { status: 'approved' };
    });
  }

  async reject(botId: string, userId: string, id: string, reviewer: string): Promise<ExpressionGovernanceOutcome> {
    return this.#transition(botId, userId, id, reviewer, (record) => {
      if (record.tombstone !== undefined || record.status === 'rejected') return undefined;
      return { status: 'rejected' };
    });
  }

  /** Marks a record superseded; when a replacement is given, stores it as an approved record and links it. */
  async supersede(
    botId: string, userId: string, id: string, reviewer: string, replacement?: ExpressionReplacement,
  ): Promise<ExpressionGovernanceOutcome> {
    const previous = await this.#load(botId, userId, id);
    if (!previous) return 'not-found';
    if (replacement !== undefined) {
      const text = replacement.text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/gu, ' ').trim();
      if (!text || text.length > MAX_TEXT || SENSITIVE.test(text) || isPromptInjectionLike(text)) return 'invalid';
      const replacementId = await this.#createReplacement(botId, userId, previous, reviewer, replacement.category ?? previous.category, text);
      const outcome = await this.#transition(botId, userId, id, reviewer, (record) => {
        if (record.status === 'superseded' && record.supersededBy === replacementId) return undefined;
        return { status: 'superseded', supersededBy: replacementId };
      });
      if (outcome === 'unchanged') return 'unchanged';
      this.#logger.info({ botId, userId, id, replacementId, reviewer }, 'expression superseded with replacement');
      return outcome;
    }
    return this.#transition(botId, userId, id, reviewer, (record) => {
      if (record.status === 'superseded') return undefined;
      return { status: 'superseded' };
    });
  }

  /** Soft delete: tombstoned records are never recalled and never resurrected by capture replay. */
  async tombstone(botId: string, userId: string, id: string, reviewer: string, reason?: string): Promise<ExpressionGovernanceOutcome> {
    return this.#transition(botId, userId, id, reviewer, (record) => {
      if (record.tombstone !== undefined) return undefined;
      return { tombstone: { at: this.#now(), reviewer, ...(reason !== undefined ? { reason } : {}) } };
    });
  }

  async list(botId: string, userId?: string, status?: ExpressionStatus): Promise<ExpressionMemoryRecord[]> {
    const prefix = userId !== undefined ? `${EXPRESSION_MEMORY_PREFIX}${botId}:${userId}:` : `${EXPRESSION_MEMORY_PREFIX}${botId}:`;
    const rows = await this.#storage.query<unknown>({ prefix, limit: 1000 });
    return rows.map((row) => row.value).filter(validRecord)
      .filter((record) => status === undefined || record.status === status)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Tombstone all records matching the filter. Returns the count of newly tombstoned records. */
  async bulkDelete(filter: BulkDeleteFilter, reviewer: string, reason?: string): Promise<number> {
    const prefix = filter.userId !== undefined
      ? `${EXPRESSION_MEMORY_PREFIX}${filter.botId}:${filter.userId}:`
      : `${EXPRESSION_MEMORY_PREFIX}${filter.botId}:`;
    const rows = await this.#storage.query<unknown>({ prefix, limit: 5000 });
    const now = this.#now();
    let count = 0;
    for (const row of rows) {
      if (!validRecord(row.value)) continue;
      const record = row.value;
      if (record.tombstone !== undefined) continue;
      if (filter.channelId !== undefined && record.channelId !== filter.channelId) continue;
      if (filter.before !== undefined && record.createdAt >= filter.before) continue;
      const updated: ExpressionMemoryRecord = {
        ...record, recordVersion: 2, reviewer, updatedAt: now,
        tombstone: { at: now, reviewer, ...(reason !== undefined ? { reason } : {}) },
      };
      await this.#storage.save(row.key, updated);
      count += 1;
    }
    if (count > 0) this.#logger.info({ botId: filter.botId, reviewer, count, reason }, 'expression memory bulk delete');
    return count;
  }

  /** List tombstoned records that have not yet expired (restorable). */
  async recycleBin(botId: string, limit = 100): Promise<ExpressionMemoryRecord[]> {
    const prefix = `${EXPRESSION_MEMORY_PREFIX}${botId}:`;
    const rows = await this.#storage.query<unknown>({ prefix, limit: 5000 });
    const now = this.#now();
    return rows.map((row) => row.value).filter(validRecord)
      .filter((record) => record.tombstone !== undefined && (record.expiresAt === undefined || record.expiresAt > now))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, Math.max(1, Math.min(limit, 1000)));
  }

  /** Restore a tombstoned record back to approved status. Only non-expired records may be restored. */
  async restore(botId: string, userId: string, id: string, reviewer: string): Promise<ExpressionGovernanceOutcome> {
    const record = await this.#load(botId, userId, id);
    if (!record) return 'not-found';
    if (record.tombstone === undefined) return 'unchanged';
    const now = this.#now();
    if (record.expiresAt !== undefined && record.expiresAt <= now) return 'invalid';
    const updated: ExpressionMemoryRecord = {
      ...record, recordVersion: 2, reviewer, updatedAt: now,
      status: 'approved', tombstone: undefined,
    };
    await this.#storage.save(this.#key(botId, userId, id), updated);
    this.#logger.info({ botId, userId, id, reviewer }, 'expression memory record restored from tombstone');
    return 'applied';
  }

  /**
   * Export sanitized JSONL lines for a bot. Strips userId, channelId, botId,
   * sourceMessageId, sourceCreatedAt, and tombstone reviewer to prevent PII leakage.
   */
  async exportSanitized(botId: string, options?: ExportOptions): Promise<string> {
    const prefix = `${EXPRESSION_MEMORY_PREFIX}${botId}:`;
    const rows = await this.#storage.query<unknown>({ prefix, limit: 5000 });
    const limit = Math.max(1, Math.min(options?.limit ?? 1000, 5000));
    const records = rows.map((row) => row.value).filter(validRecord)
      .filter((record) => options?.status === undefined || record.status === options.status)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
    const lines: string[] = [];
    for (const record of records) {
      const sanitized: SanitizedExpressionRecord = {
        id: record.id,
        category: record.category,
        text: record.text,
        normalized: record.normalized,
        status: record.status,
        confidence: record.confidence,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        ...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
        ...(record.sourcePlatform !== undefined ? { sourcePlatform: record.sourcePlatform } : {}),
        ...(record.reviewer !== undefined ? { reviewer: record.reviewer } : {}),
        ...(record.tombstone !== undefined ? { tombstone: { at: record.tombstone.at, ...(record.tombstone.reason !== undefined ? { reason: record.tombstone.reason } : {}) } } : {}),
      };
      lines.push(JSON.stringify(sanitized));
    }
    return lines.join('\n');
  }

  async #transition(
    botId: string, userId: string, id: string, reviewer: string,
    change: (record: ExpressionMemoryRecord) => Partial<ExpressionMemoryRecord> | undefined,
  ): Promise<ExpressionGovernanceOutcome> {
    const previous = await this.#load(botId, userId, id);
    if (!previous) return 'not-found';
    const delta = change(previous);
    if (delta === undefined) return 'unchanged';
    const updated: ExpressionMemoryRecord = {
      ...previous, ...delta,
      recordVersion: 2, reviewer, updatedAt: this.#now(),
    };
    await this.#storage.save(this.#key(botId, userId, id), updated);
    this.#logger.info({ botId, userId, id, reviewer, status: updated.status }, 'expression memory record reviewed');
    return 'applied';
  }

  async #createReplacement(
    botId: string, userId: string, previous: ExpressionMemoryRecord, reviewer: string,
    category: ExpressionCategory, text: string,
  ): Promise<string> {
    const { createHash } = await import('node:crypto');
    const id = createHash('sha256').update(`${botId}\0${userId}\0${category}\0${text.toLocaleLowerCase()}`).digest('hex').slice(0, 32);
    const now = this.#now();
    const record: ExpressionMemoryRecord = {
      kind: 'expression-memory', recordVersion: 2, id, botId, userId,
      channelId: previous.channelId, category, text, normalized: text.toLocaleLowerCase(),
      status: 'approved', confidence: previous.confidence, createdAt: now, updatedAt: now, reviewer,
      ...(previous.sourceMessageId !== undefined ? { sourceMessageId: previous.sourceMessageId } : {}),
      ...(previous.sourcePlatform !== undefined ? { sourcePlatform: previous.sourcePlatform } : {}),
      ...(previous.sourceCreatedAt !== undefined ? { sourceCreatedAt: previous.sourceCreatedAt } : {}),
      ...(previous.expiresAt !== undefined ? { expiresAt: previous.expiresAt } : {}),
    };
    await this.#storage.save(this.#key(botId, userId, id), record);
    return id;
  }

  async #load(botId: string, userId: string, id: string): Promise<ExpressionMemoryRecord | undefined> {
    const value = await this.#storage.get<unknown>(this.#key(botId, userId, id));
    return validRecord(value) ? value : undefined;
  }

  #key(botId: string, userId: string, id: string): string { return `${EXPRESSION_MEMORY_PREFIX}${botId}:${userId}:${id}`; }
}
