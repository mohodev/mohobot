import path from 'node:path';
import { VersionedJsonStore } from '../core/versioned-json.js';

export type AffinityDeltaReason = 'helpful' | 'kind' | 'shared-interest' | 'conflict' | 'ignored' | 'manual';
export interface AffinityRecord { botId: string; userId: string; score: number; interactions: number; lastReason: AffinityDeltaReason; updatedAt: string; notes: string[]; }
function clamp(value: number): number { return Math.max(-100, Math.min(100, Math.round(value * 100) / 100)); }
function normalizeRows(value: unknown): AffinityRecord[] { if (!Array.isArray(value)) throw new Error('affinity data must be an array'); return value as AffinityRecord[]; }

export class AffinityStore {
  readonly #store: VersionedJsonStore<AffinityRecord[]>;
  constructor(rootDir: string) { this.#store = new VersionedJsonStore({ file: path.join(rootDir, 'data', 'memory', 'affinity.json'), defaultValue: () => [], normalize: normalizeRows }); }
  async get(botId: string, userId: string): Promise<AffinityRecord> {
    const rows = await this.#store.get();
    return rows.find((row) => row.botId === botId && row.userId === userId) ?? { botId, userId, score: 0, interactions: 0, lastReason: 'manual', updatedAt: new Date(0).toISOString(), notes: [] };
  }
  async list(botId?: string): Promise<AffinityRecord[]> { return (await this.#store.get()).filter((row) => !botId || row.botId === botId).sort((a, b) => b.score - a.score); }
  async adjust(botId: string, userId: string, delta: number, reason: AffinityDeltaReason, note?: string): Promise<AffinityRecord> {
    let result!: AffinityRecord;
    await this.#store.update((rows) => {
      const current = rows.find((row) => row.botId === botId && row.userId === userId) ?? { botId, userId, score: 0, interactions: 0, lastReason: 'manual' as const, updatedAt: new Date(0).toISOString(), notes: [] };
      result = { ...current, score: clamp(current.score + delta), interactions: current.interactions + 1, lastReason: reason, updatedAt: new Date().toISOString(), notes: note ? [...current.notes, note].slice(-20) : current.notes };
      return [...rows.filter((row) => row.botId !== botId || row.userId !== userId), result];
    });
    return result;
  }
}
