import { describe, expect, it } from 'vitest';

import { SessionConfigSchema, type SessionConfig } from '../config/schema.js';
import { createNullLogger } from '../core/logger.js';
import type { ChatMessage } from '../core/types.js';
import type { QueryFilter, Storage, StoredRecord } from '../storage/types.js';
import { SessionManager, type Summarizer } from './manager.js';

const logger = createNullLogger();
const input = { botId: 'bot1', channelId: 'chan1', userId: 'user1' };

type CS = Partial<SessionConfig['contextSummary']>;

function config(overrides: Partial<Omit<SessionConfig, 'contextSummary'>> = {}, cs: CS = {}): SessionConfig {
  return SessionConfigSchema.parse({
    persist: false,
    maxMessages: 200,
    maxChars: 1_000_000,
    ...overrides,
    contextSummary: { trimAtRounds: 4, trimRemoveRounds: 2, minKeepMessages: 2, ...cs },
  });
}

function turn(i: number, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}`, ...extra };
}

async function fill(mgr: SessionManager, count: number, extra: (i: number) => Partial<ChatMessage> = () => ({})): Promise<void> {
  for (let i = 0; i < count; i += 1) await mgr.append(input, turn(i, extra(i)));
}

function fakeStorage(): Storage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async init() {},
    async save<T>(key: string, value: T) { data.set(key, JSON.parse(JSON.stringify(value)) as unknown); },
    async get<T>(key: string) { return data.get(key) as T | undefined; },
    async delete(key: string) { data.delete(key); },
    async query<T>(filter: QueryFilter): Promise<StoredRecord<T>[]> {
      return [...data.entries()].filter(([k]) => !filter.prefix || k.startsWith(filter.prefix))
        .map(([key, value]) => ({ key, value: value as T, updatedAt: Date.now() }));
    },
    async purgeExpired() { return 0; },
    async close() {},
  };
}

function recorder(reply: string | ((n: number) => string) = 'SUMMARY'): { fn: Summarizer; calls: Array<Parameters<Summarizer>[0]> } {
  const calls: Array<Parameters<Summarizer>[0]> = [];
  const fn: Summarizer = async (args) => {
    calls.push(args);
    return typeof reply === 'function' ? reply(calls.length) : reply;
  };
  return { fn, calls };
}

describe('context summary compaction', () => {
  it('folds the oldest rounds into a summary once enough rounds accumulate', async () => {
    const rec = recorder('S1');
    const mgr = new SessionManager({ botId: 'bot1', config: config(), logger, summarizer: rec.fn });
    await fill(mgr, 7); // ceil(7/2)=4 rounds -> trigger on the 7th append
    await mgr.flush();

    const session = await mgr.get(input);
    expect(session.summary?.text).toBe('S1');
    expect(session.summary?.coveredMessages).toBe(4);
    expect(session.messages.map((m) => m.content)).toEqual(['m4', 'm5', 'm6']);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]?.previousSummary).toBeUndefined();
    expect(rec.calls[0]?.messages.map((m) => m.content)).toEqual(['m0', 'm1', 'm2', 'm3']);
    expect(await mgr.getSummary(input)).toBe('S1');
  });

  it('does nothing below the threshold and exposes no summary', async () => {
    const rec = recorder();
    const mgr = new SessionManager({ botId: 'bot1', config: config(), logger, summarizer: rec.fn });
    await fill(mgr, 6);
    await mgr.flush();
    expect(rec.calls).toHaveLength(0);
    expect(await mgr.getSummary(input)).toBeUndefined();
    expect((await mgr.get(input)).messages).toHaveLength(6);
  });

  it('folds the previous summary into the next one and accumulates coverage', async () => {
    const rec = recorder((n) => `S${n}`);
    const mgr = new SessionManager({ botId: 'bot1', config: config(), logger, summarizer: rec.fn });
    await fill(mgr, 7);
    await mgr.flush();
    for (let i = 7; i < 12; i += 1) await mgr.append(input, turn(i));
    await mgr.flush();

    expect(rec.calls.length).toBeGreaterThanOrEqual(2);
    expect(rec.calls[1]?.previousSummary).toBe('S1');
    const session = await mgr.get(input);
    expect(session.summary?.text).toBe(`S${rec.calls.length}`);
    expect(session.summary!.coveredMessages).toBeGreaterThan(4);
  });

  it('keeps all data when the summarizer throws, and recovers afterwards', async () => {
    let fail = true;
    const calls: number[] = [];
    const summarizer: Summarizer = async () => {
      calls.push(1);
      if (fail) throw new Error('model down');
      return 'OK';
    };
    const mgr = new SessionManager({ botId: 'bot1', config: config(), logger, summarizer });
    await fill(mgr, 7);
    await mgr.flush();

    let session = await mgr.get(input);
    expect(session.summary).toBeUndefined();
    expect(session.messages).toHaveLength(7);

    fail = false;
    await mgr.append(input, turn(7));
    await mgr.flush();
    session = await mgr.get(input);
    expect(session.summary?.text).toBe('OK');
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps data when the summarizer returns nothing', async () => {
    const mgr = new SessionManager({ botId: 'bot1', config: config(), logger, summarizer: async () => '   ' });
    await fill(mgr, 7);
    await mgr.flush();
    const session = await mgr.get(input);
    expect(session.summary).toBeUndefined();
    expect(session.messages).toHaveLength(7);
  });

  it('truncates an oversized summary to maxSummaryChars', async () => {
    const rec = recorder('x'.repeat(5000));
    const mgr = new SessionManager({ botId: 'bot1', config: config({}, { maxSummaryChars: 300 }), logger, summarizer: rec.fn });
    await fill(mgr, 7);
    await mgr.flush();
    expect((await mgr.get(input)).summary?.text).toHaveLength(300);
  });

  it('is inert when disabled or when no summarizer is attached (legacy hard trim)', async () => {
    const rec = recorder();
    const off = new SessionManager({ botId: 'bot1', config: config({ maxMessages: 3 }, { enabled: false }), logger, summarizer: rec.fn });
    await fill(off, 7);
    await off.flush();
    expect(rec.calls).toHaveLength(0);
    expect((await off.get(input)).messages.map((m) => m.content)).toEqual(['m4', 'm5', 'm6']);

    const none = new SessionManager({ botId: 'bot1', config: config({ maxMessages: 3 }), logger });
    await fill(none, 7);
    expect((await none.get(input)).messages).toHaveLength(3);
    expect(none.summarizing).toBe(false);
  });

  it('raises the hard message ceiling while summarizing so turns are folded, not dropped', async () => {
    const rec = recorder();
    const mgr = new SessionManager({ botId: 'bot1', config: config({ maxMessages: 3 }, { trimAtRounds: 40 }), logger, summarizer: rec.fn });
    await fill(mgr, 6);
    await mgr.flush();
    expect((await mgr.get(input)).messages).toHaveLength(6);
    expect(mgr.summarizing).toBe(true);
  });

  it('also triggers on the character budget and compacts to roughly half of it', async () => {
    const rec = recorder();
    const mgr = new SessionManager({
      botId: 'bot1',
      config: config({ maxChars: 100 }, { trimAtRounds: 50, triggerRatio: 0.5, trimRemoveRounds: 1 }),
      logger,
      summarizer: rec.fn,
    });
    for (let i = 0; i < 3; i += 1) await mgr.append(input, { role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(20) });
    await mgr.flush();
    const session = await mgr.get(input);
    expect(rec.calls).toHaveLength(1);
    expect(session.summary).toBeDefined();
    expect(session.messages.length).toBeLessThan(3);
  });

  it('never compacts away the newest minKeepMessages', async () => {
    const rec = recorder();
    const mgr = new SessionManager({ botId: 'bot1', config: config({}, { trimRemoveRounds: 50, minKeepMessages: 3 }), logger, summarizer: rec.fn });
    await fill(mgr, 7);
    await mgr.flush();
    const kept = (await mgr.get(input)).messages;
    expect(kept.map((m) => m.content)).toEqual(['m4', 'm5', 'm6']);
  });

  it('runs at most one summarizer call per session at a time', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const summarizer: Summarizer = async () => { calls += 1; await gate; return 'LATE'; };
    const mgr = new SessionManager({ botId: 'bot1', config: config(), logger, summarizer });
    await fill(mgr, 7);
    await fill(mgr, 3); // more appends while the first summarization is still running
    expect(calls).toBe(1);
    release();
    await mgr.flush();
    expect(calls).toBeGreaterThanOrEqual(1);
    expect((await mgr.get(input)).summary?.text).toBe('LATE');
  });

  it('discards a result that arrives after the session was cleared', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const summarizer: Summarizer = async () => { await gate; return 'STALE'; };
    const mgr = new SessionManager({ botId: 'bot1', config: config(), logger, summarizer });
    await fill(mgr, 7);
    await mgr.clear(input);
    release();
    await mgr.flush();
    expect(await mgr.getSummary(input)).toBeUndefined();
    expect((await mgr.get(input)).messages).toHaveLength(0);
  });

  it('discards a result when the head was altered while summarizing', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const summarizer: Summarizer = async () => { await gate; return 'RACED'; };
    const mgr = new SessionManager({ botId: 'bot1', config: config({ maxMessages: 200 }), logger, summarizer });
    await fill(mgr, 7);
    const session = await mgr.get(input);
    session.messages.shift(); // simulate a concurrent hard trim eating the head
    release();
    await mgr.flush();
    expect(session.summary).toBeUndefined();
  });

  it('drops a tombstone-only head without calling the model', async () => {
    const rec = recorder();
    const mgr = new SessionManager({ botId: 'bot1', config: config({}, { trimAtRounds: 3, trimRemoveRounds: 1 }), logger, summarizer: rec.fn });
    await fill(mgr, 7, (i) => (i < 2 ? { deleted: true } : {})); // 2 tombstones then 5 live turns
    await mgr.flush();
    expect(rec.calls).toHaveLength(0);
    const session = await mgr.get(input);
    expect(session.summary).toBeUndefined();
    expect(session.messages.map((m) => m.content)).toEqual(['m2', 'm3', 'm4', 'm5', 'm6']);
  });

  it('only hands live turns to the summarizer, never tombstones', async () => {
    const rec = recorder();
    const mgr = new SessionManager({ botId: 'bot1', config: config(), logger, summarizer: rec.fn });
    await fill(mgr, 10, (i) => (i < 3 ? { deleted: true } : {})); // 7 live turns -> 4 rounds
    await mgr.flush();
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]?.messages.map((m) => m.content)).toEqual(['m3']);
    expect((await mgr.get(input)).messages.map((m) => m.content)).toEqual(['m4', 'm5', 'm6', 'm7', 'm8', 'm9']);
  });

  it('persists the summary as recordVersion 2 and restores it after a restart', async () => {
    const storage = fakeStorage();
    const cfg = config({ persist: true });
    const first = new SessionManager({ botId: 'bot1', config: cfg, logger, storage, summarizer: recorder('KEEP ME').fn });
    await fill(first, 7);
    await first.flush();
    expect(storage.data.get('session:bot1:chan1:user1')).toMatchObject({ kind: 'session', recordVersion: 2, summary: { text: 'KEEP ME' } });

    const second = new SessionManager({ botId: 'bot1', config: cfg, logger, storage });
    expect(await second.getSummary(input)).toBe('KEEP ME');
    expect((await second.get(input)).messages.map((m) => m.content)).toEqual(['m4', 'm5', 'm6']);
  });

  it('keeps unsummarized sessions at recordVersion 1 for older builds', async () => {
    const storage = fakeStorage();
    const mgr = new SessionManager({ botId: 'bot1', config: config({ persist: true }), logger, storage, summarizer: recorder().fn });
    await fill(mgr, 3);
    await mgr.flush();
    const record = storage.data.get('session:bot1:chan1:user1') as Record<string, unknown>;
    expect(record.recordVersion).toBe(1);
    expect(record.summary).toBeUndefined();
  });

  it('drops a corrupt stored summary but keeps the conversation', async () => {
    const storage = fakeStorage();
    const key = 'session:bot1:chan1:user1';
    storage.data.set(key, { kind: 'session', recordVersion: 2, key, botId: 'bot1', channelId: 'chan1', userId: 'user1',
      messages: [{ role: 'user', content: 'hi' }], summary: { text: 42 }, updatedAt: 5 });
    const mgr = new SessionManager({ botId: 'bot1', config: config({ persist: true }), logger, storage });
    expect(await mgr.getSummary(input)).toBeUndefined();
    expect((await mgr.get(input)).messages.map((m) => m.content)).toEqual(['hi']);
  });
});

describe('age-based sweep', () => {
  const HOUR = 3_600_000;

  function aged(now: number, oldCount: number, freshCount: number): { build: (mgr: SessionManager) => Promise<void> } {
    return {
      async build(mgr) {
        for (let i = 0; i < oldCount + freshCount; i += 1) {
          await mgr.append(input, turn(i, { createdAt: i < oldCount ? now - 6 * HOUR : now - 1000 }));
        }
      },
    };
  }

  it('summarizes idle turns older than summaryAgeHours and spares recent ones', async () => {
    const now = Date.now();
    const rec = recorder('AGED');
    const mgr = new SessionManager({ botId: 'bot1', config: config({}, { trimAtRounds: 50 }), logger, summarizer: rec.fn });
    await aged(now, 6, 4).build(mgr);
    expect(await mgr.sweepCompaction(now)).toBe(1);
    await mgr.flush();

    const session = await mgr.get(input);
    expect(session.summary?.text).toBe('AGED');
    expect(session.messages).toHaveLength(4);
    expect(session.messages.every((m) => (m.createdAt ?? 0) > now - HOUR)).toBe(true);
  });

  it('does not re-summarize inside minIntervalHours', async () => {
    const now = Date.now();
    const rec = recorder('AGED');
    const mgr = new SessionManager({ botId: 'bot1', config: config({}, { trimAtRounds: 50 }), logger, summarizer: rec.fn });
    await aged(now, 6, 4).build(mgr);
    await mgr.sweepCompaction(now);
    await mgr.flush();
    // New stale-looking turns arrive, but the day gate still holds.
    const session = await mgr.get(input);
    for (let i = 0; i < 6; i += 1) session.messages.unshift(turn(100 + i, { createdAt: now - 7 * HOUR }));
    expect(await mgr.sweepCompaction(now + HOUR)).toBe(0);
    expect(rec.calls).toHaveLength(1);
  });

  it('never treats turns without a timestamp as old', async () => {
    const mgr = new SessionManager({ botId: 'bot1', config: config({}, { trimAtRounds: 50 }), logger, summarizer: recorder().fn });
    await fill(mgr, 10);
    expect(await mgr.sweepCompaction(Date.now() + 100 * HOUR)).toBe(0);
  });

  it('ignores a handful of stray old lines', async () => {
    const now = Date.now();
    const mgr = new SessionManager({ botId: 'bot1', config: config({}, { trimAtRounds: 50 }), logger, summarizer: recorder().fn });
    await aged(now, 2, 6).build(mgr);
    expect(await mgr.sweepCompaction(now)).toBe(0);
  });

  it('is a no-op when sweeping is disabled', async () => {
    const now = Date.now();
    const mgr = new SessionManager({ botId: 'bot1', config: config({}, { trimAtRounds: 50, sweepEnabled: false }), logger, summarizer: recorder().fn });
    await aged(now, 6, 4).build(mgr);
    expect(await mgr.sweepCompaction(now)).toBe(0);
  });
});
