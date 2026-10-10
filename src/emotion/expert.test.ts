import { describe, expect, it, vi } from 'vitest';

import { EmotionalState } from './models.js';
import { EmotionExpert } from './expert.js';

function expert(chat: (prompt: string, model?: string) => Promise<string | null>) {
  return new EmotionExpert({ chat, retries: 1, retryDelayMs: 0, sleep: async () => {} });
}

describe('EmotionExpert parsing', () => {
  it('reads deltas, clamps them per dimension and keeps the descriptions', () => {
    const raw = [
      '```json',
      '{"emotion_updates":{"favor":99,"intimacy":-50,"joy":1,"anger":-9},',
      '"relationship":"欢喜冤家","attitude":"表面嫌弃"}',
      '```',
    ].join('\n');
    const updates = EmotionExpert.parse(raw);
    expect(updates.favor).toBe(5);
    expect(updates.intimacy).toBe(-5);
    expect(updates.joy).toBe(1);
    expect(updates.anger).toBe(-3);
    expect(updates.relationshipText).toBe('欢喜冤家');
    expect(updates.attitudeText).toBe('表面嫌弃');
  });

  it('repairs loosely quoted JSON from small models', () => {
    const raw = "{emotion_updates: {favor: 2, 'joy': 1,},relationship: '老熟人', attitude: '热络'}";
    const updates = EmotionExpert.parse(raw);
    expect(updates.favor).toBe(2);
    expect(updates.joy).toBe(1);
    expect(updates.relationshipText).toBe('老熟人');
  });

  it('rejects output without an emotion_updates object', () => {
    expect(() => EmotionExpert.parse('{"whatever": 1}')).toThrow(/emotion_updates/);
    expect(() => EmotionExpert.parse('no json here')).toThrow(/no JSON/i);
  });
});

describe('EmotionExpert analysis', () => {
  it('marks a successful analysis as llm_analysis and resets failures', async () => {
    const chat = vi.fn(async () => '{"emotion_updates":{"favor":2,"joy":1},"relationship":"熟人","attitude":"轻松"}');
    const expertUnderTest = expert(chat);
    const updates = await expertUnderTest.analyze('谢谢你呀', '不客气～', new EmotionalState('u'), '洛天依');
    expect(updates.source).toBe('llm_analysis');
    expect(updates.favor).toBe(2);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(expertUnderTest.llmAvailable).toBe(true);
  });

  it('falls back to keywords when the model returns nothing useful', async () => {
    const expertUnderTest = expert(async () => '   ');
    const updates = await expertUnderTest.analyze('好喜欢你', '嘿嘿', new EmotionalState('u'), '洛天依');
    expect(updates.source).toBe('smart_fallback');
    expect(updates.favor).toBeGreaterThan(0);
    expect(updates.joy).toBeGreaterThan(0);
  });

  it('scores negative messages downward in fallback mode', async () => {
    const expertUnderTest = expert(async () => { throw new Error('network down'); });
    const updates = await expertUnderTest.analyze('我讨厌你，滚', '……', new EmotionalState('u'), '洛天依');
    expect(updates.favor).toBeLessThan(0);
    expect(updates.sadness + updates.anger + updates.disgust).toBeGreaterThan(0);
  });

  it('opens the circuit after repeated failures and closes it again later', async () => {
    let clock = 0;
    const chat = vi.fn(async (): Promise<string | null> => { throw new Error('always down'); });
    const expertUnderTest = new EmotionExpert({
      chat, retries: 2, retryDelayMs: 0, sleep: async () => {},
      now: () => clock,
    });
    for (let turn = 0; turn < 3; turn += 1) {
      await expertUnderTest.analyze('你好', '嗨', new EmotionalState('u'), '洛天依');
    }
    expect(expertUnderTest.llmAvailable).toBe(false);
    expect(expertUnderTest.status().tripped).toBe(true);
    expect(chat).toHaveBeenCalledTimes(6); // 3 analyses x 2 retries

    clock += 6 * 60_000;
    chat.mockImplementation(async () => '{"emotion_updates":{"favor":1},"relationship":"熟人","attitude":"轻松"}');
    const updates = await expertUnderTest.analyze('早', '嗯', new EmotionalState('u'), '洛天依');
    expect(updates.source).toBe('llm_analysis');
    expect(expertUnderTest.llmAvailable).toBe(true);
    expect(expertUnderTest.status().tripped).toBe(false);
  });

  it('never leaves a dimension undefined', async () => {
    const updates = await expert(async () => null).analyze('嗯', '嗯', new EmotionalState('u'), '洛天依');
    for (const field of ['favor', 'intimacy', 'joy', 'trust', 'fear', 'surprise', 'sadness', 'disgust', 'anger', 'anticipation'] as const) {
      expect(typeof updates[field]).toBe('number');
    }
    expect(updates.relationshipText.length).toBeGreaterThan(0);
  });
});
