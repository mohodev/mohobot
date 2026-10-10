import { describe, expect, it } from 'vitest';

import { EmotionalState, STAGE_NAMES } from './models.js';
import { StageManager } from './relationship.js';

function stateWith(favor: number, intimacy: number): EmotionalState {
  const state = new EmotionalState('u');
  state.favor = favor;
  state.intimacy = intimacy;
  return state;
}

describe('StageManager composite score', () => {
  it('starts at 初识期 for a stranger', () => {
    const info = StageManager.getStageInfo(stateWith(0, 0));
    expect(info.stage).toBe('INITIAL');
    expect(info.stageName).toBe(STAGE_NAMES.INITIAL);
    expect(info.isMaxStage).toBe(false);
  });

  it('advances 初识 → 深化 → 承诺 → 共生 as the composite grows', () => {
    // Thresholds are on the weighted composite, not on favor alone.
    expect(StageManager.getStageInfo(stateWith(20, 10)).stageName).toBe(STAGE_NAMES.INITIAL);
    expect(StageManager.getStageInfo(stateWith(70, 40)).stageName).toBe(STAGE_NAMES.DEEPENING);
    expect(StageManager.getStageInfo(stateWith(90, 80)).stageName).toBe(STAGE_NAMES.COMMITMENT);
    expect(StageManager.getStageInfo(stateWith(95, 95)).stageName).toBe(STAGE_NAMES.SYMBIOSIS);
    expect(StageManager.getStageInfo(stateWith(95, 95)).isMaxStage).toBe(true);
  });

  it('needs the full threshold to rise but only threshold-5 to fall', () => {
    const state = stateWith(70, 40);
    expect(StageManager.getStageInfo(state).stageName).toBe(STAGE_NAMES.DEEPENING);
    // 深化期 reaches its threshold at 55; a dip to 52.5 is inside the hysteresis
    // band, so the relationship is not demoted on one quiet evening.
    state.favor = 55;
    state.intimacy = 45;
    expect(StageManager.getStageInfo(state).stageName).toBe(STAGE_NAMES.DEEPENING);
    // Outside the band it does drop.
    state.favor = 30;
    state.intimacy = 20;
    expect(StageManager.getStageInfo(state).stageName).toBe(STAGE_NAMES.INITIAL);
  });

  it('carries the best composite score forward across stages', () => {
    const state = stateWith(95, 95);
    expect(StageManager.getStageInfo(state).compositeScore).toBe(95);
    state.favor = 70;
    state.intimacy = 40;
    const info = StageManager.getStageInfo(state);
    expect(info.stageName).toBe(STAGE_NAMES.DEEPENING);
    expect(info.compositeScore).toBe(95);
  });

  it('uses repair stages for negative favor', () => {
    expect(StageManager.getStageInfo(stateWith(-10, 0)).stageName).toBe(STAGE_NAMES.COLD);
    expect(StageManager.getStageInfo(stateWith(-50, 0)).stageName).toBe(STAGE_NAMES.DISLIKE);
    expect(StageManager.getStageInfo(stateWith(-90, 0)).stageName).toBe(STAGE_NAMES.HOSTILE);
  });

  it('caches stage fields on the state for the injected prompt', () => {
    const state = stateWith(95, 95);
    StageManager.getStageInfo(state);
    expect(state.relationshipStage).toBe(STAGE_NAMES.SYMBIOSIS);
    expect(state.stageCompositeScore).toBeGreaterThan(0);
    expect(state.stageProgress).toBeGreaterThanOrEqual(0);
  });
});

describe('StageManager transition benefits', () => {
  it('boosts positive moods into intimacy while a stage change settles', () => {
    const state = stateWith(70, 40);
    StageManager.getStageInfo(state); // 深化期, protected score 55
    // Dropping out of 深化期 keeps the old score protected, so the new stage
    // needs extra intimacy to settle - positive moods convert into it.
    state.favor = 30;
    state.intimacy = 20;
    const boosted = StageManager.applyTransitionBenefits(state, { joy: 2, trust: 1 });
    expect(typeof boosted.intimacy).toBe('number');
    expect(boosted.intimacy).toBeGreaterThan(0);
  });

  it('multiplies an explicit intimacy gain during a transition', () => {
    const state = stateWith(70, 40);
    StageManager.getStageInfo(state);
    state.favor = 30;
    state.intimacy = 20;
    const boosted = StageManager.applyTransitionBenefits(state, { intimacy: 2 });
    expect(boosted.intimacy).toBeGreaterThan(2);
  });

  it('leaves updates untouched when no transition is active', () => {
    const state = stateWith(0, 0);
    StageManager.getStageInfo(state);
    const updates = { joy: 1 };
    expect(StageManager.applyTransitionBenefits(state, updates)).toEqual({ joy: 1 });
  });
});

describe('StageManager advice', () => {
  it('explains each stage in human terms', () => {
    expect(StageManager.getStageAdvice(stateWith(100, 100))).toContain('共生期');
    expect(StageManager.getStageAdvice(stateWith(-10, 0))).toContain('冷淡期');
    expect(StageManager.getStageAdvice(stateWith(-50, 0))).toContain('反感期');
    expect(StageManager.getStageAdvice(stateWith(-95, 0))).toContain('敌对期');
  });
});
