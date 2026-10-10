import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createNullLogger } from '../core/logger.js';
import { EmotionalState } from './models.js';
import { EmotionManager, type EmotionRuntimeConfig, shouldUpdate, significanceOf } from './manager.js';

const logger = createNullLogger();
let root = '';

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = '';
});

const BASE_CONFIG: EmotionRuntimeConfig = {
  enabled: true,
  analysisRoundCooldown: 0,
  minIntervalMs: 0,
  forceUpdateInterval: 100,
  keywordThreshold: 3,
  significanceThreshold: 3,
  smartUpdate: true,
  analysisTimeoutMs: 1000,
  maxConcurrent: 1,
  favorMin: -100,
  favorMax: 100,
  intimacyMin: 0,
  intimacyMax: 100,
};

function manager(
  chat: (prompt: string, model?: string) => Promise<string | null>,
  overrides: Partial<EmotionRuntimeConfig> = {},
  now = () => 1_000_000,
): EmotionManager {
  return new EmotionManager({
    rootDir: root,
    botId: 'main',
    logger,
    chat,
    now,
    config: { ...BASE_CONFIG, ...overrides },
  });
}

const LLM_OK = '{"emotion_updates":{"favor":2,"intimacy":1,"joy":2},"relationship":"熟人","attitude":"轻松"}';

describe('EmotionManager turn processing', () => {
  it('applies a real analysis, records the interaction and injects a tone block', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'moho-emotion-'));
    const m = manager(async () => LLM_OK);
    await m.processTurn('user-1', '好喜欢你呀', '嘿嘿，谢谢');
    await m.settle();

    const snapshot = await m.getSnapshot('user-1');
    expect(snapshot.favor).toBe(2);
    expect(snapshot.intimacy).toBe(1);
    expect(snapshot.interactions.total).toBe(1);
    expect(snapshot.attitude).toBe('轻松');
    expect(snapshot.relationship).toBe('熟人');

    const block = await m.buildContextBlock('user-1');
    expect(block).toContain('【情感回应风格】');
    expect(block).toContain('好感度：2 | 亲密度：1');
    expect(block).toContain('主导情感');
    // The raw user text must never leak into the injected block.
    expect(block).not.toContain('好喜欢你呀');
  });

  it('honours the round cooldown and skips analysis while it is open', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'moho-emotion-'));
    let calls = 0;
    const m = manager(async () => { calls += 1; return LLM_OK; }, { analysisRoundCooldown: 3 });
    await m.processTurn('u', '第一句', '回复');
    await m.settle();
    expect(calls).toBe(1);
    await m.processTurn('u', '第二句', '回复');
    await m.settle();
    expect(calls).toBe(1); // still inside the cooldown window
    const snapshot = await m.getSnapshot('u');
    expect(snapshot.interactions.total).toBe(1);
  });

  it('respects the wall-clock interval floor for one user', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'moho-emotion-'));
    let clock = 1_000_000;
    let calls = 0;
    const m = manager(async () => { calls += 1; return LLM_OK; }, { minIntervalMs: 5_000 }, () => clock);
    await m.processTurn('u', '第一句', '回复');
    await m.settle();
    expect(calls).toBe(1);
    clock += 1_000; // only a second later
    await m.processTurn('u', '第二句', '回复');
    await m.settle();
    expect(calls).toBe(1);
    clock += 10_000;
    await m.processTurn('u', '第三句，我太喜欢你了', '回复');
    await m.settle();
    expect(calls).toBe(2);
  });

  it('persists and reloads state across manager instances', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'moho-emotion-'));
    const first = manager(async () => '{"emotion_updates":{"favor":4,"intimacy":4},"relationship":"好朋友","attitude":"亲昵"}');
    await first.processTurn('u', '谢谢你', '不客气～');
    await first.settle();
    await first.flush();

    const second = manager(async () => { throw new Error('must not be called'); });
    const snapshot = await second.getSnapshot('u');
    expect(snapshot.favor).toBe(4);
    expect(snapshot.intimacy).toBe(4);
    expect(snapshot.relationship).toBe('好朋友');
  });

  it('keeps the long-term memory file capped per user', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'moho-emotion-'));
    const m = manager(
      async () => '{"emotion_updates":{"favor":5,"intimacy":5,"joy":5},"relationship":"挚友","attitude":"热烈"}',
      { forceUpdateInterval: 1, keywordThreshold: 1, significanceThreshold: 1 },
    );
    for (let turn = 0; turn < 60; turn += 1) {
      await m.processTurn('u', `第${turn}次说喜欢你`, '我也喜欢你');
      await m.settle();
    }
    await m.flush();
    const memoryFile = JSON.parse(await fs.readFile(path.join(root, 'data', 'emotion', 'main', 'memory.json'), 'utf8')) as Record<string, unknown[]>;
    expect(memoryFile.u).toHaveLength(50);
  });

  it('trips the circuit when the analysis model keeps failing and still scores keywords', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'moho-emotion-'));
    const m = manager(async () => { throw new Error('down'); }, { forceUpdateInterval: 1, keywordThreshold: 1 });
    for (let turn = 0; turn < 4; turn += 1) {
      await m.processTurn('u', '我讨厌你', '……');
      await m.settle();
    }
    expect(m.circuitStatus().tripped).toBe(true);
    const snapshot = await m.getSnapshot('u');
    expect(snapshot.favor).toBeLessThan(0);
  });

  it('supports ranking, explicit values and reset', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'moho-emotion-'));
    const m = manager(async () => LLM_OK);
    m.setFavor('a', 30);
    m.setIntimacy('a', 40);
    m.setFavor('b', -5);
    const top = await m.ranking(10, 'top');
    expect(top.map((row) => row.userKey)).toEqual(['a', 'b']);
    expect(top[0]?.stage).toBeTruthy();

    // Reset zeroes the user but keeps them on the board, above the negative one.
    const reset = m.resetUser('a');
    expect(reset.favor).toBe(0);
    expect(reset.intimacy).toBe(0);
    const after = await m.ranking(10, 'top');
    expect(after.map((row) => row.userKey)).toEqual(['a', 'b']);
    expect(after[0]?.favor).toBe(0);
  });

  it('refuses to analyse error placeholders and stays silent when disabled', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'moho-emotion-'));
    let calls = 0;
    const counting = manager(async () => { calls += 1; return LLM_OK; });
    counting.scheduleTurn('u', '你好', '[AI 调用失败：超时]');
    await counting.settle();
    expect(calls).toBe(0);

    const disabled = new EmotionManager({
      rootDir: root, botId: 'main', logger, now: () => 1_000_000,
      chat: async () => { calls += 1; return LLM_OK; },
      config: { ...BASE_CONFIG, enabled: false },
    });
    await disabled.processTurn('u', '你好', '嗨');
    await disabled.settle();
    expect(await disabled.buildContextBlock('u')).toBe('');
    expect(calls).toBe(0);
  });
});

describe('significance and update gating', () => {
  it('maps total change onto a 1..8 scale', () => {
    expect(significanceOf({ favor: 0, intimacy: 0, joy: 0 })).toBe(1);
    expect(significanceOf({ favor: 3 })).toBe(3);
    expect(significanceOf({ favor: 3, joy: 3 })).toBe(5);
    expect(significanceOf({ favor: 5, joy: 5 })).toBe(8);
  });

  it('skips quiet turns and flags emotional ones', () => {
    const now = 5_000_000;
    const state = new EmotionalState('u');
    // A brand new state is always "stale" (timestamps are 0), which is what
    // seeds a first analysis - so seed it first for the quiet-turn check.
    state.descriptions.updateAttitude('中立', now);
    state.lastForceUpdate = now;
    expect(shouldUpdate(state, '今天天气不错', 100, 3, now).update).toBe(false);
    expect(shouldUpdate(state, '我真的很讨厌你', 100, 3, now).update).toBe(true);
    expect(shouldUpdate(state, '我太喜欢你了', 100, 3, now).reason).toContain('积极');
    // A forced interval still fires once the counter fills up.
    state.forceUpdateCounter = 9;
    expect(shouldUpdate(state, '嗯', 8, 3, now).reason).toContain('强制更新');
  });
});
