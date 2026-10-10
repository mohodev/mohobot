/**
 * Tests for the persona A/B evaluation service.
 *
 * The properties under test are the ones that make the numbers meaningful:
 * both sides see the same prepared input, A/B positions are shuffled, only a
 * confirmed delivery counts, votes never move the persona by themselves, and a
 * superseded turn sends nothing.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  PersonaAbRepository,
  PersonaAbService,
  type AbSide,
  type PersonaAbConfig,
  type PersonaSnapshot,
} from './persona-ab.js';

let root = '';
let clock = 1_000_000;

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = '';
  clock = 1_000_000;
});

const BASE_CONFIG: PersonaAbConfig = {
  enabled: true,
  probability: 1,
  cooldownSeconds: 0,
  pendingSeconds: 3_600,
};

function snapshot(side: AbSide, content: string): PersonaSnapshot {
  return { id: `${side}.txt`, label: `${side}.txt`, content, hash: `hash-${side}-${content.length}` };
}

function service(overrides: {
  config?: Partial<PersonaAbConfig>;
  send?: (content: string) => Promise<boolean>;
  shuffle?: <T>(items: T[]) => T[];
  random?: () => number;
  now?: () => number;
} = {}) {
  const sent: string[] = [];
  const svc = new PersonaAbService({
    rootDir: root,
    botId: 'main',
    config: { ...BASE_CONFIG, ...overrides.config },
    loadPrompt: async () => { throw new Error('unused'); },
    send: overrides.send ?? (async (content: string) => { sent.push(content); return true; }),
    now: overrides.now ?? (() => clock),
    shuffle: overrides.shuffle,
    random: overrides.random ?? (() => 0),
  });
  return { svc, sent };
}

async function reserveOk(
  svc: PersonaAbService,
  userId = 'u1',
  contextSide: AbSide = 'baseline',
  sourceMessageId = `m-${Math.random().toString(36).slice(2)}`,
) {
  const record = await svc.reserve({
    userId,
    sourceMessageId,
    contextSide,
    baseline: snapshot('baseline', '你是A'),
    test: snapshot('test', '你是B'),
  });
  expect(record).not.toBeNull();
  return record!;
}

describe('PersonaAbService sampling gate', () => {
  it('stays silent when disabled', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'moho-ab-'));
    const { svc } = service({ config: { enabled: false } });
    expect(await svc.reserve({ userId: 'u', sourceMessageId: 'm1', contextSide: 'baseline', baseline: snapshot('baseline', 'A'), test: snapshot('test', 'B') })).toBeNull();
  });

  it('refuses identical prompts: no comparison is possible', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'moho-ab-'));
    const { svc } = service();
    const same = snapshot('baseline', 'same text');
    expect(await svc.reserve({ userId: 'u', sourceMessageId: 'm1', contextSide: 'baseline', baseline: same, test: { ...same, id: 'test.txt', label: 'test.txt' } })).toBeNull();
  });

  it('honours the sampling probability', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'moho-ab-'));
    const { svc } = service({ config: { probability: 0 }, random: () => 0.999 });
    expect(await svc.reserve({ userId: 'u', sourceMessageId: 'm1', contextSide: 'baseline', baseline: snapshot('baseline', 'A'), test: snapshot('test', 'B') })).toBeNull();
  });

  it('allows one active evaluation per user and enforces the cooldown', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'moho-ab-'));
    const { svc } = service({ config: { cooldownSeconds: 900 } });
    const first = await reserveOk(svc, 'u');
    expect(first.state).toBe('generating');
    // Still active: no second record.
    expect(await svc.reserve({ userId: 'u', sourceMessageId: 'm2', contextSide: 'baseline', baseline: snapshot('baseline', 'A'), test: snapshot('test', 'B') })).toBeNull();
    await svc.evaluate(first, async (persona) => `答[${persona}]`);
    // Vote releases the slot, but the cooldown still holds.
    await svc.vote('u', first.id, 'A');
    expect(await svc.reserve({ userId: 'u', sourceMessageId: 'm3', contextSide: 'baseline', baseline: snapshot('baseline', 'A'), test: snapshot('test', 'B') })).toBeNull();
    // After the cooldown a new record is allowed.
    clock += 901_000;
    const second = await svc.reserve({ userId: 'u', sourceMessageId: 'm4', contextSide: 'baseline', baseline: snapshot('baseline', 'A'), test: snapshot('test', 'B') });
    expect(second).not.toBeNull();
    // A different user is never blocked by someone else's evaluation.
    const other = await svc.reserve({ userId: 'v', sourceMessageId: 'm5', contextSide: 'baseline', baseline: snapshot('baseline', 'A'), test: snapshot('test', 'B') });
    expect(other).not.toBeNull();
  });

  it('dedupes by source message id', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'moho-ab-'));
    const { svc } = service();
    const first = await reserveOk(svc, 'u', 'baseline', 'same-msg');
    await svc.evaluate(first, async (persona) => `答[${persona}]`);
    await svc.vote('u', undefined, '跳过');
    // Same message id can never start a second evaluation.
    clock += 10_000;
    expect(await svc.reserve({ userId: 'u', sourceMessageId: 'same-msg', contextSide: 'baseline', baseline: snapshot('baseline', 'A'), test: snapshot('test', 'B') })).toBeNull();
  });

  it('shuffles the A/B mapping per record', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'moho-ab-'));
    const forward = service({ shuffle: (items) => [...items] });
    const reversed = service({ shuffle: (items) => [...items].reverse() });
    const a = await forward.svc.reserve({ userId: 'u', sourceMessageId: 'm1', contextSide: 'baseline', baseline: snapshot('baseline', 'A'), test: snapshot('test', 'B') });
    const b = await reversed.svc.reserve({ userId: 'v', sourceMessageId: 'm2', contextSide: 'baseline', baseline: snapshot('baseline', 'A'), test: snapshot('test', 'B') });
    expect(a!.mapping).toEqual({ A: 'baseline', B: 'test' });
    expect(b!.mapping).toEqual({ A: 'test', B: 'baseline' });
  });
});

describe('PersonaAbService evaluation', () => {
  it('delivers notice + card and counts the exposure on confirmed delivery', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'moho-ab-'));
    const { svc, sent } = service();
    const record = await reserveOk(svc, 'u', 'test');
    const outcome = await svc.evaluate(record, async (persona) => `答[${persona}]`);
    expect(outcome).toEqual({ reply: '答[你是B]', exposed: true, aborted: false });
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain('?ab A');
    expect(sent[1]).toContain('🧪 人设对比');
    expect(sent[1]).toContain('答[你是A]');
    expect(sent[1]).toContain('答[你是B]');

    const stats = await svc.stats();
    expect(stats.shown).toBe(1);
  });

  it('returns the context side for normal delivery when one side fails', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'moho-ab-'));
    const { svc, sent } = service();
    const record = await reserveOk(svc, 'u', 'baseline');
    let baselineCalls = 0;
    const outcome = await svc.evaluate(record, async (persona) => {
      if (persona === '你是A') {
        baselineCalls += 1;
        if (baselineCalls === 1) throw new Error('boom');
        return '重试成功';
      }
      return 'B正常';
    });
    // No card (only one candidate): the context answer is returned for the
    // caller to deliver exactly once - the service itself sends nothing here.
    expect(outcome.exposed).toBe(false);
    expect(outcome.reply).toBe('重试成功');
    expect(sent).toHaveLength(0);
    const stats = await svc.stats();
    expect(stats.shown).toBe(0);
    expect(stats.failed).toBe(1);
  });

  it('returns empty for the caller to answer normally when both sides fail', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'moho-ab-'));
    const { svc, sent } = service();
    const record = await reserveOk(svc);
    const outcome = await svc.evaluate(record, async () => { throw new Error('down'); });
    expect(outcome).toEqual({ reply: '', exposed: false, aborted: false });
    expect(sent).toHaveLength(0);
  });

  it('sends nothing and flags aborted when superseded mid-flight', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'moho-ab-'));
    const { svc, sent } = service();
    const record = await reserveOk(svc);
    const outcome = await svc.evaluate(record, async (persona) => `答[${persona}]`, { shouldAbort: () => true });
    expect(outcome).toEqual({ reply: '', exposed: false, aborted: true });
    expect(sent).toHaveLength(0);
    const stats = await svc.stats();
    expect(stats.shown).toBe(0);
  });

  it('does not count an undelivered card as an exposure', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'moho-ab-'));
    let calls = 0;
    const { svc, sent } = service({
      send: async (content: string) => { calls += 1; sent.push(content); return calls > 1; },
    });
    const record = await reserveOk(svc);
    const outcome = await svc.evaluate(record, async (persona) => `答[${persona}]`);
    // Notice ok, card failed: the context answer is still returned for normal
    // delivery, but the comparison is uncounted.
    expect(outcome.exposed).toBe(false);
    expect(outcome.reply).toBe('答[你是A]');
    const stats = await svc.stats();
    expect(stats.shown).toBe(0);
    expect(stats.failed).toBe(1);
  });
});

describe('PersonaAbService voting and switching', () => {
  it('records a vote, clears the slot and keeps the first choice on re-vote', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'moho-ab-'));
    const { svc } = service();
    const record = await reserveOk(svc);
    await svc.evaluate(record, async (persona) => `答[${persona}]`);

    const voted = await svc.vote('u1', undefined, 'B');
    expect(voted.vote).toBe('B');
    expect(voted.state).toBe('voted');
    const again = await svc.vote('u1', voted.id, 'A');
    expect(again.vote).toBe('B');

    // Slot released: a new evaluation may start after the cooldown... here 0.
    clock += 1_000;
    const next = await svc.reserve({ userId: 'u1', sourceMessageId: 'm-next', contextSide: 'baseline', baseline: snapshot('baseline', 'A'), test: snapshot('test', 'B') });
    expect(next).not.toBeNull();
  });

  it('rejects votes for unknown or expired records', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'moho-ab-'));
    const { svc } = service();
    await expect(svc.vote('ghost', undefined, 'A')).rejects.toThrow(/不存在/);
    const record = await reserveOk(svc);
    await svc.evaluate(record, async (persona) => `答[${persona}]`);
    clock += 3_601_000; // past pendingSeconds
    await expect(svc.vote('u1', record.id, 'A')).rejects.toThrow(/过期/);
    expect(await svc.loadVotable('u1', record.id)).toBeNull();
  });

  it('switch binds the persona without touching anything else', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'moho-ab-'));
    const { svc } = service({ shuffle: (items) => [...items] }); // A=baseline
    const record = await reserveOk(svc);
    await svc.evaluate(record, async (persona) => `答[${persona}]`);
    await svc.vote('u1', undefined, 'B');
    const switched = await svc.switchPersona('u1', record.id, 'B');
    expect(switched.switch).toMatchObject({ choice: 'B', side: 'test' });
    expect(await svc.preference('u1')).toBe('test');
    expect(await svc.preference('nobody')).toBeNull();
  });

  it('attributes wins through the shuffled mapping', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'moho-ab-'));
    const forward = service({ shuffle: (items) => [...items] }); // A=baseline
    const r1 = await forward.svc.reserve({ userId: 'u', sourceMessageId: 'm1', contextSide: 'baseline', baseline: snapshot('baseline', 'A'), test: snapshot('test', 'B') });
    await forward.svc.evaluate(r1!, async (persona) => `答[${persona}]`);
    await forward.svc.vote('u', undefined, 'A'); // votes baseline

    const reversed = service({ shuffle: (items) => [...items].reverse() }); // A=test
    const r2 = await reversed.svc.reserve({ userId: 'v', sourceMessageId: 'm2', contextSide: 'baseline', baseline: snapshot('baseline', 'A'), test: snapshot('test', 'B') });
    await reversed.svc.evaluate(r2!, async (persona) => `答[${persona}]`);
    await reversed.svc.vote('v', undefined, 'A'); // votes test

    const r3 = await forward.svc.reserve({ userId: 'w', sourceMessageId: 'm3', contextSide: 'baseline', baseline: snapshot('baseline', 'A'), test: snapshot('test', 'B') });
    await forward.svc.evaluate(r3!, async (persona) => `答[${persona}]`);
    await forward.svc.vote('w', undefined, '平局');

    const stats = await forward.svc.stats();
    expect(stats.shown).toBe(3);
    expect(stats.votes).toBe(3);
    expect(stats.baselineWins).toBe(1);
    expect(stats.testWins).toBe(1);
    expect(stats.ties).toBe(1);
    expect(stats.responseRate).toBe(1);
  });
});

describe('PersonaAbRepository', () => {
  it('repairs interrupted work on startup and persists across instances', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'moho-ab-'));
    const first = service();
    const record = await reserveOk(first.svc);
    expect(record.state).toBe('generating');

    const repo = new PersonaAbRepository(root);
    expect(await repo.recover('main')).toBe(1);

    const second = service();
    const stats = await second.svc.stats();
    expect(stats.failed).toBe(1);
    expect(stats.shown).toBe(0);
  });
});
