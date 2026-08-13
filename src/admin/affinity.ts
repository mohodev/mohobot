import fs from 'node:fs/promises';
import path from 'node:path';

export type AffinityDeltaReason = 'helpful' | 'kind' | 'shared-interest' | 'conflict' | 'ignored' | 'manual';

export interface AffinityRecord {
  botId: string;
  userId: string;
  score: number;
  interactions: number;
  lastReason: AffinityDeltaReason;
  updatedAt: string;
  notes: string[];
}

function clamp(value: number): number { return Math.max(-100, Math.min(100, Math.round(value * 100) / 100)); }

export class AffinityStore {
  readonly #file: string;
  #records = new Map<string, AffinityRecord>();
  #loaded = false;
  #write: Promise<void> = Promise.resolve();

  constructor(rootDir: string) { this.#file = path.join(rootDir, 'data', 'memory', 'affinity.json'); }

  async #load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const rows = JSON.parse(await fs.readFile(this.#file, 'utf8')) as AffinityRecord[];
      for (const row of rows) this.#records.set(`${row.botId}:${row.userId}`, row);
    } catch {
      // First run or corrupt optional cache: start empty and recover on next write.
    }
  }

  async get(botId: string, userId: string): Promise<AffinityRecord> {
    await this.#load();
    return this.#records.get(`${botId}:${userId}`) ?? {
      botId, userId, score: 0, interactions: 0, lastReason: 'manual', updatedAt: new Date(0).toISOString(), notes: [],
    };
  }

  async list(botId?: string): Promise<AffinityRecord[]> {
    await this.#load();
    return [...this.#records.values()].filter((row) => !botId || row.botId === botId).sort((a, b) => b.score - a.score);
  }

  async adjust(botId: string, userId: string, delta: number, reason: AffinityDeltaReason, note?: string): Promise<AffinityRecord> {
    await this.#load();
    const current = await this.get(botId, userId);
    const next: AffinityRecord = {
      ...current,
      score: clamp(current.score + delta),
      interactions: current.interactions + 1,
      lastReason: reason,
      updatedAt: new Date().toISOString(),
      notes: note ? [...current.notes, note].slice(-20) : current.notes,
    };
    this.#records.set(`${botId}:${userId}`, next);
    this.#write = this.#write.then(async () => {
      await fs.mkdir(path.dirname(this.#file), { recursive: true });
      await fs.writeFile(this.#file, JSON.stringify([...this.#records.values()], null, 2) + '\n', 'utf8');
    });
    await this.#write;
    return next;
  }
}
