import type { Logger } from '../core/logger.js';
import type { Storage } from '../storage/types.js';
import type { SemanticMemoryRecord } from './semantic-memory.js';

export interface SemanticBulkDeleteFilter { botId: string; userId?: string; channelId?: string; sourceMessageId?: string; }
export interface SanitizedSemanticRecord { id: string; scope: SemanticMemoryRecord['scope']; text: string; createdAt: number; tombstone?: { at: number; reason?: string }; }
const PREFIX = 'semantic-memory:';
function valid(value: unknown): value is SemanticMemoryRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Partial<SemanticMemoryRecord>;
  return typeof r.id === 'string' && typeof r.botId === 'string' && typeof r.userId === 'string' && typeof r.channelId === 'string' && typeof r.text === 'string' && Number.isFinite(r.createdAt) && ['private', 'relationship', 'shared'].includes(String(r.scope));
}

export class SemanticMemoryGovernance {
  constructor(readonly storage: Storage, readonly logger: Logger, readonly now: () => number = Date.now) {}

  async bulkDelete(filter: SemanticBulkDeleteFilter, reviewer: string, reason?: string): Promise<number> {
    const rows = await this.storage.query<unknown>({ prefix: `${PREFIX}${filter.botId}:`, limit: 5000 });
    let count = 0;
    for (const row of rows) {
      if (!valid(row.value) || row.value.tombstone) continue;
      const r = row.value;
      if (filter.userId !== undefined && r.userId !== filter.userId) continue;
      if (filter.channelId !== undefined && r.channelId !== filter.channelId) continue;
      if (filter.sourceMessageId !== undefined && r.user.sourceMessageId !== filter.sourceMessageId) continue;
      await this.storage.save(row.key, { ...r, vector: undefined, embeddingModel: undefined, tombstone: { at: this.now(), reviewer, ...(reason ? { reason } : {}) } });
      count += 1;
    }
    if (count) this.logger.info({ botId: filter.botId, reviewer, count }, 'semantic memory bulk tombstone');
    return count;
  }

  async forgetSourceMessage(input: { botId: string; sourceMessageId: string; sourcePlatform: string; deletedAt: number }): Promise<void> {
    const rows = await this.storage.query<unknown>({ prefix: `${PREFIX}${input.botId}:`, limit: 5000 });
    for (const row of rows) {
      if (!valid(row.value) || row.value.tombstone) continue;
      const source = row.value.user;
      if (source.sourceMessageId !== input.sourceMessageId || source.sourcePlatform !== input.sourcePlatform) continue;
      await this.storage.save(row.key, { ...row.value, vector: undefined, embeddingModel: undefined, tombstone: { at: input.deletedAt, reason: `source message ${input.sourceMessageId} deleted` } });
    }
  }

  async recycleBin(botId: string, limit = 100): Promise<SemanticMemoryRecord[]> {
    const rows = await this.storage.query<unknown>({ prefix: `${PREFIX}${botId}:`, limit: 5000 });
    return rows.map((r) => r.value).filter(valid).filter((r) => r.tombstone !== undefined).slice(0, Math.max(1, Math.min(limit, 1000)));
  }

  async restore(botId: string, userId: string, id: string, reviewer: string): Promise<'applied' | 'unchanged' | 'not-found'> {
    // Key layout does not reliably embed userId; filter on record fields instead.
    const rows = await this.storage.query<unknown>({ prefix: `${PREFIX}${botId}:`, limit: 5000 });
    const row = rows.find((r) => valid(r.value) && r.value.userId === userId && r.value.id === id);
    if (!row || !valid(row.value)) return 'not-found';
    if (!row.value.tombstone) return 'unchanged';
    const { tombstone: _tombstone, ...record } = row.value;
    await this.storage.save(row.key, record);
    this.logger.info({ botId, userId, id, reviewer }, 'semantic memory restored');
    return 'applied';
  }

  async exportSanitized(botId: string): Promise<string> {
    const rows = await this.storage.query<unknown>({ prefix: `${PREFIX}${botId}:`, limit: 5000 });
    return rows.map((r) => r.value).filter(valid).map((r): SanitizedSemanticRecord => ({ id: r.id, scope: r.scope, text: r.text, createdAt: r.createdAt, ...(r.tombstone ? { tombstone: { at: r.tombstone.at, ...(r.tombstone.reason ? { reason: r.tombstone.reason } : {}) } } : {}) })).map((r) => JSON.stringify(r)).join('\n');
  }

  dryRunImport(jsonl: string): { lines: number; valid: number; invalid: number; records: SanitizedSemanticRecord[] } {
    const records: SanitizedSemanticRecord[] = [];
    let lines = 0;
    let invalid = 0;
    for (const line of jsonl.split(/\r?\n/u).filter((v) => v.trim())) {
      lines += 1;
      try {
        const r = JSON.parse(line) as Partial<SanitizedSemanticRecord>;
        if (typeof r.id !== 'string' || typeof r.text !== 'string' || !Number.isFinite(r.createdAt) || !['private', 'relationship', 'shared'].includes(String(r.scope))) { invalid += 1; continue; }
        records.push(r as SanitizedSemanticRecord);
      } catch { invalid += 1; }
    }
    return { lines, valid: records.length, invalid, records };
  }
}
