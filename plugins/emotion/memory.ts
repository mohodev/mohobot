/**
 * Long-term interaction memory — ported from upstream `mohobot/emotion/memory.py`.
 *
 * Interactions with significance >= threshold are written to a per-user ring
 * (max 50); a global top-50 "important events" heap is maintained. The
 * "relationship trajectory" text is injected before the LLM call.
 */

const MAX_PER_USER = 50;
const MAX_IMPORTANT_EVENTS = 50;

export interface InteractionRecord {
  userMsg: string;
  aiResponse: string;
  timestamp: number;
  significance: number;
  emotionalChanges: Record<string, number>;
}

export interface MemoryStats {
  longTermCount: number;
  avgSignificance: number;
  lastInteraction: number;
}

export class MemorySystem {
  #perUser = new Map<string, InteractionRecord[]>();
  #important: Array<{ significance: number; timestamp: number; userKey: string; preview: string }> = [];

  load(records: Record<string, unknown>): void {
    this.#perUser.clear();
    this.#important = [];
    for (const [userKey, rawItems] of Object.entries(records ?? {})) {
      if (!Array.isArray(rawItems)) continue;
      const items: InteractionRecord[] = [];
      for (const raw of rawItems.slice(-MAX_PER_USER)) {
        const record = decodeRecord(raw);
        if (record) items.push(record);
      }
      if (items.length > 0) {
        this.#perUser.set(userKey, items);
        for (const record of items) {
          if (record.significance >= 1) this.#pushImportant(userKey, record);
        }
      }
    }
  }

  serialize(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [userKey, items] of this.#perUser) out[userKey] = items.map(encodeRecord);
    return out;
  }

  addInteraction(userKey: string, userMsg: string, aiResponse: string, significance: number, emotionalChanges: Record<string, number>, threshold: number): boolean {
    const record: InteractionRecord = {
      userMsg: (userMsg ?? '').slice(0, 500),
      aiResponse: (aiResponse ?? '').slice(0, 500),
      timestamp: Date.now(),
      significance,
      emotionalChanges: { ...(emotionalChanges ?? {}) },
    };
    if (record.significance < threshold) return false;
    const items = this.#perUser.get(userKey) ?? [];
    items.push(record);
    while (items.length > MAX_PER_USER) items.shift();
    this.#perUser.set(userKey, items);
    this.#pushImportant(userKey, record);
    return true;
  }

  #pushImportant(userKey: string, record: InteractionRecord): void {
    this.#important.push({ significance: record.significance, timestamp: record.timestamp, userKey, preview: record.userMsg.slice(0, 100) });
    this.#important.sort((a, b) => b.significance - a.significance || a.timestamp - b.timestamp);
    while (this.#important.length > MAX_IMPORTANT_EVENTS) this.#important.pop();
  }

  buildRelationshipContext(userKey: string): string {
    const records = this.#perUser.get(userKey);
    if (!records || records.length === 0) return '';
    const importantCount = this.#important.filter((event) => event.userKey === userKey).length;
    const avg = records.reduce((n, r) => n + r.significance, 0) / records.length;
    const recentSignificant = records.filter((r) => r.significance >= 7).length;
    const lines = ['【长期关系发展轨迹】', `深度互动次数: ${records.length}`, `平均情感深度: ${avg.toFixed(1)}/10`];
    if (recentSignificant) lines.push(`近期重要互动: ${recentSignificant}次`);
    if (importantCount) lines.push(`重要时刻: ${importantCount}个`);
    return lines.join('\n');
  }

  userMemoryStats(userKey: string): MemoryStats {
    const records = this.#perUser.get(userKey);
    if (!records || records.length === 0) return { longTermCount: 0, avgSignificance: 0, lastInteraction: 0 };
    return {
      longTermCount: records.length,
      avgSignificance: records.reduce((n, r) => n + r.significance, 0) / records.length,
      lastInteraction: records[records.length - 1]?.timestamp ?? 0,
    };
  }

  clearUser(userKey: string): void {
    this.#perUser.delete(userKey);
    this.#important = this.#important.filter((event) => event.userKey !== userKey);
  }

  clearAll(): void {
    this.#perUser.clear();
    this.#important = [];
  }

  stats(): { users: number; records: number } {
    let records = 0;
    for (const items of this.#perUser.values()) records += items.length;
    return { users: this.#perUser.size, records };
  }
}

function encodeRecord(record: InteractionRecord): Record<string, unknown> {
  return { userMsg: record.userMsg, aiResponse: record.aiResponse, timestamp: record.timestamp, significance: record.significance, emotionalChanges: record.emotionalChanges };
}

function decodeRecord(raw: unknown): InteractionRecord | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  const changes = row.emotionalChanges ?? {};
  const emotionalChanges: Record<string, number> = {};
  if (changes && typeof changes === 'object' && !Array.isArray(changes)) {
    for (const [key, value] of Object.entries(changes as Record<string, unknown>)) {
      if (typeof value === 'number') emotionalChanges[key] = value;
    }
  }
  return {
    userMsg: String(row.userMsg ?? '').slice(0, 500),
    aiResponse: String(row.aiResponse ?? '').slice(0, 500),
    timestamp: Number(row.timestamp) || 0,
    significance: Math.round(Number(row.significance) || 0),
    emotionalChanges,
  };
}
