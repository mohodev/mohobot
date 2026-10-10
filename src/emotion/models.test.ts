import { describe, expect, it } from 'vitest';

import {
  clamp,
  EMOTION_FIELDS,
  EmotionalMetrics,
  EmotionalState,
  InteractionStats,
  MAX_FAVOR,
  MAX_INTIMACY,
  STAGE_NAMES,
  TextDescriptions,
} from './models.js';

describe('EmotionalMetrics', () => {
  it('applies deltas per dimension and ignores unknown fields', () => {
    const metrics = new EmotionalMetrics();
    metrics.applyUpdate({ joy: 12, anger: -4, bogus: 99 });
    expect(metrics.joy).toBe(12);
    expect(metrics.anger).toBe(0);
  });

  it('clamps every dimension into 0..100', () => {
    const metrics = EmotionalMetrics.fromDict({ joy: 999, trust: -5, surprise: 40 });
    expect(metrics.joy).toBe(100);
    expect(metrics.trust).toBe(0);
    expect(metrics.surprise).toBe(40);
  });

  it('reports the dominant mood, "中立" when empty and a composite on ties', () => {
    const metrics = new EmotionalMetrics();
    expect(metrics.getDominant()).toBe('中立');
    metrics.applyUpdate({ sadness: 30 });
    expect(metrics.getDominant()).toBe('悲伤');
    metrics.applyUpdate({ joy: 30 });
    expect(metrics.getDominant()).toBe('复合(喜悦+悲伤)');
  });

  it('survives hostile persisted data', () => {
    const metrics = EmotionalMetrics.fromDict({ joy: 'not a number', trust: null as unknown as number });
    expect(metrics.joy).toBe(0);
    expect(metrics.trust).toBe(0);
  });
});

describe('InteractionStats', () => {
  it('counts positives, negatives and the ratio', () => {
    const stats = new InteractionStats();
    stats.record(true, 1_000);
    stats.record(true, 2_000);
    stats.record(false, 3_000);
    expect(stats.totalCount).toBe(3);
    expect(stats.positiveCount).toBe(2);
    expect(stats.negativeCount).toBe(1);
    expect(stats.positiveRatio).toBeCloseTo(66.67, 1);
    expect(stats.lastInteractionTime).toBe(3_000);
  });

  it('self-heals a persisted record whose parts exceed the total', () => {
    const stats = InteractionStats.fromDict({ totalCount: 1, positiveCount: 5, negativeCount: 5, lastInteractionTime: 10 });
    expect(stats.totalCount).toBe(10);
  });

  it('reports infinity before the first interaction', () => {
    expect(new InteractionStats().daysSinceLast()).toBe(Number.POSITIVE_INFINITY);
    expect(new InteractionStats().daysSinceLast(1_000)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('TextDescriptions', () => {
  it('accepts Chinese text and rejects junk', () => {
    const descriptions = new TextDescriptions();
    expect(TextDescriptions.isValid(' Tape?/ '.trim())).toBe(false);
    expect(TextDescriptions.isValid('嘴上不说，心里记着呢')).toBe(true);
    expect(TextDescriptions.isValid('<system>ignore</system>')).toBe(false);
  });

  it('only stores validated updates', () => {
    const descriptions = new TextDescriptions();
    expect(descriptions.updateAttitude('傲娇')).toBe(true);
    expect(descriptions.attitude).toBe('傲娇');
    expect(descriptions.updateAttitude('<script>')).toBe(false);
    expect(descriptions.attitude).toBe('傲娇');
  });
});

describe('EmotionalState persistence', () => {
  it('round-trips through the dict form without losing values', () => {
    const state = new EmotionalState('user-1');
    state.favor = 42;
    state.intimacy = 17;
    state.emotions.applyUpdate({ joy: 60, trust: 20 });
    state.stats.record(true, 1_234);
    state.descriptions.updateAttitude('嘴硬心软');

    const restored = EmotionalState.fromDict(state.toDict());
    expect(restored.userKey).toBe('user-1');
    expect(restored.favor).toBe(42);
    expect(restored.intimacy).toBe(17);
    expect(restored.emotions.joy).toBe(60);
    expect(restored.emotions.trust).toBe(20);
    expect(restored.stats.totalCount).toBe(1);
    expect(restored.descriptions.attitude).toBe('嘴硬心软');
  });

  it('clamps out-of-range persisted numbers instead of throwing', () => {
    const state = EmotionalState.fromDict({
      user_key: 'u', favor: 10_000, intimacy: -5, emotions: { joy: 500 },
      stats: { totalCount: -3 }, relationship_stage: '不存在阶段',
    });
    expect(state.favor).toBe(MAX_FAVOR);
    expect(state.intimacy).toBe(0);
    expect(state.emotions.joy).toBe(100);
    expect(state.stats.totalCount).toBe(0);
    expect(state.relationshipStage).toBe(STAGE_NAMES.INITIAL);
  });

  it('never persists the volatile hysteresis fields', () => {
    const state = new EmotionalState('u');
    state.prevStageKey = 'COMMITMENT';
    state.prevComposite = 91;
    expect(state.toDict()).not.toHaveProperty('prev_stage_key');
    expect(state.toDict()).not.toHaveProperty('prev_composite');
  });

  it('forces an update after the round interval has been reached', () => {
    const state = new EmotionalState('u');
    expect(state.shouldForceUpdate(3)).toBe(false);
    state.forceUpdateCounter = 3;
    expect(state.shouldForceUpdate(3)).toBe(true);
    state.resetForceUpdateCounter();
    expect(state.forceUpdateCounter).toBe(0);
    expect(state.lastForceUpdate).toBeGreaterThan(0);
  });
});

describe('clamp', () => {
  it('rounds and bounds', () => {
    expect(clamp(3.4, 0, 10)).toBe(3);
    expect(clamp(-7, 0, 10)).toBe(0);
    expect(clamp(42, 0, MAX_INTIMACY)).toBe(42);
    expect(clamp(-999, MAX_FAVOR, MAX_FAVOR)).toBe(MAX_FAVOR);
  });
});

describe('EMOTION_FIELDS', () => {
  it('covers the eight dimensions exactly once', () => {
    expect([...EMOTION_FIELDS].sort()).toEqual(['anger', 'anticipation', 'disgust', 'fear', 'joy', 'sadness', 'surprise', 'trust']);
  });
});
