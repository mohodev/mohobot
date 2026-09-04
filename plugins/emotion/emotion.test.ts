import { describe, expect, it } from 'vitest';

import {
  clamp, defaultState, deserializeState, serializeState, dominantEmotion, emotionIntensity,
} from './models.js';
import { getBehaviorGuidance, getToneInstruction } from './attitude.js';
import { getStageAdvice, refreshStage, applyTransitionBenefits } from './relationship.js';
import { EmotionExpert, smartFallback } from './expert.js';
import { SmartUpdateManager } from './smart.js';
import { MemorySystem } from './memory.js';

describe('models', () => {
  it('clamps and round-trips state', () => {
    const state = defaultState();
    state.favor = 45;
    state.intimacy = 30;
    const restored = deserializeState(serializeState(state));
    expect(restored.favor).toBe(45);
    expect(restored.intimacy).toBe(30);
    expect(restored.relationshipStage).toBe('初识期');
  });

  it('clamps out-of-range values', () => {
    expect(clamp(999, -100, 100)).toBe(100);
    expect(clamp(-999, -100, 100)).toBe(-100);
    const restored = deserializeState({ favor: 999, intimacy: -5 });
    expect(restored.favor).toBe(100);
    expect(restored.intimacy).toBe(0);
  });

  it('reports dominant emotion and intensity', () => {
    const state = defaultState();
    state.emotions.joy = 60;
    state.emotions.trust = 60;
    expect(dominantEmotion(state.emotions)).toContain('复合');
    state.emotions.trust = 10;
    expect(dominantEmotion(state.emotions)).toBe('喜悦');
    expect(emotionIntensity(state.emotions)).toBe(0.6);
  });
});

describe('attitude', () => {
  it('maps composite scores to behaviour styles', () => {
    expect(getBehaviorGuidance(90, 80)).toContain('热情');
    expect(getBehaviorGuidance(50, 50)).toContain('积极');
    expect(getBehaviorGuidance(0, 0)).toContain('客观');
    expect(getBehaviorGuidance(-40, 0)).toContain('冷淡');
    expect(getBehaviorGuidance(-90, 0)).toContain('尖锐');
  });

  it('returns a tone instruction for any state', () => {
    const state = defaultState();
    expect(getToneInstruction(state).length).toBeGreaterThan(0);
  });
});

describe('relationship stages', () => {
  it('starts at INITIAL and progresses with favor/intimacy', () => {
    const state = defaultState();
    const info = refreshStage(state);
    expect(info.stage).toBe('INITIAL');
    expect(info.stageName).toBe('初识期');
  });

  it('reaches DEEPENING at high favor + intimacy', () => {
    const state = defaultState();
    state.favor = 70;
    state.intimacy = 60;
    const info = refreshStage(state);
    expect(info.stage).toBe('DEEPENING');
    expect(info.stageName).toBe('深化期');
  });

  it('enters negative stages when favor drops', () => {
    const state = defaultState();
    state.favor = -45;
    const info = refreshStage(state);
    expect(info.stage).toBeNull();
    expect(info.stageName).toBe('反感期');
  });

  it('gives stage advice', () => {
    const state = defaultState();
    expect(getStageAdvice(state).length).toBeGreaterThan(0);
  });

  it('amplifies intimacy during transitions', () => {
    const state = defaultState();
    state.favor = 30;
    state.intimacy = 20;
    refreshStage(state);
    const updates = applyTransitionBenefits(state, { favor: 0, intimacy: 2, joy: 1 });
    expect(typeof updates['intimacy']).toBe('number');
  });
});

describe('EmotionExpert', () => {
  it('uses the LLM result when it returns valid JSON', async () => {
    const expert = new EmotionExpert(async () =>
      JSON.stringify({ emotion_updates: { favor: 2, intimacy: 1, joy: 1, trust: 0, fear: 0, surprise: 0, sadness: 0, disgust: 0, anger: 0, anticipation: 0 }, relationship: '朋友', attitude: '友好' }),
    );
    const updates = await expert.analyze('你好呀', '你好！', defaultState(), 'AI');
    expect(updates.source).toBe('llm_analysis');
    expect(updates.favor).toBe(2);
    expect(updates.relationshipText).toBe('朋友');
  });

  it('falls back to keywords when the LLM fails', async () => {
    const expert = new EmotionExpert(async () => { throw new Error('down'); });
    const updates = await expert.analyze('我真的很讨厌你！', '……', defaultState(), 'AI');
    expect(updates.source).toBe('smart_fallback');
    expect(updates.favor).toBeLessThan(0);
  });

  it('clamps over-large deltas', async () => {
    const expert = new EmotionExpert(async () =>
      JSON.stringify({ emotion_updates: { favor: 99, intimacy: 99, joy: 99, trust: 0, fear: 0, surprise: 0, sadness: 0, disgust: 0, anger: 0, anticipation: 0 }, relationship: 'x', attitude: 'y' }),
    );
    const updates = await expert.analyze('hi', 'hi', defaultState(), 'AI');
    expect(updates.favor).toBe(5); // FAVOR_DELTA_LIMIT
    expect(updates.joy).toBe(3); // EMOTION_DELTA_LIMIT
  });

  it('smart fallback returns neutral for plain text', () => {
    const updates = smartFallback('今天天气不错', '是呀');
    expect(updates.favor).toBeGreaterThanOrEqual(0);
  });
});

describe('SmartUpdateManager', () => {
  const smart = new SmartUpdateManager();
  it('updates on strong negative emotion', () => {
    const state = defaultState();
    const result = smart.shouldUpdate(state, '我真的很讨厌你', '……', 6);
    expect(result.update).toBe(true);
  });
  it('skips update for plain text on a recently-updated state', () => {
    const state = defaultState();
    const now = Date.now();
    state.descriptions.lastAttitudeUpdate = now;
    state.descriptions.lastRelationshipUpdate = now;
    state.lastForceUpdate = now;
    const result = smart.shouldUpdate(state, '嗯', '嗯', 6);
    expect(result.update).toBe(false);
  });
});

describe('MemorySystem', () => {
  it('stores significant interactions and builds context', () => {
    const memory = new MemorySystem();
    expect(memory.addInteraction('u1', '我爱你', '我也爱你', 8, { favor: 3 }, 3)).toBe(true);
    expect(memory.addInteraction('u1', '路过', '嗯', 1, {}, 3)).toBe(false);
    const context = memory.buildRelationshipContext('u1');
    expect(context).toContain('深度互动次数: 1');
    expect(memory.userMemoryStats('u1').longTermCount).toBe(1);
  });
});
