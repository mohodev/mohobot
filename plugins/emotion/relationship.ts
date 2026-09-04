/**
 * Relationship stage management — ported from upstream
 * `mohobot/emotion/relationship.py`.
 *
 * 4 positive stages (初识/深化/承诺/共生) + 3 negative stages (冷淡/反感/敌对).
 * Composite = favor×weight + intimacy×weight; ascent threshold > descent
 * threshold (hysteresis band) to avoid oscillation.
 */

import type { EmotionalState, StageKey } from './models.js';
import { STAGE_ORDER, STAGE_NAMES } from './models.js';

interface StageConfig {
  key: StageKey;
  name: string;
  description: string;
  favorWeight: number;
  intimacyWeight: number;
  compositeThreshold: number;
  transitionBuffer: number;
  intimacyBoostFactor: number;
}

export const STAGE_CONFIGS: Record<StageKey, StageConfig> = {
  INITIAL: { key: 'INITIAL', name: '初识期', description: '好感驱动，建立吸引', favorWeight: 0.7, intimacyWeight: 0.3, compositeThreshold: 25, transitionBuffer: 3, intimacyBoostFactor: 4.0 },
  DEEPENING: { key: 'DEEPENING', name: '深化期', description: '互动平衡，共同成长', favorWeight: 0.5, intimacyWeight: 0.5, compositeThreshold: 55, transitionBuffer: 5, intimacyBoostFactor: 3.6 },
  COMMITMENT: { key: 'COMMITMENT', name: '承诺期', description: '亲密主导，根基稳固', favorWeight: 0.3, intimacyWeight: 0.7, compositeThreshold: 80, transitionBuffer: 7, intimacyBoostFactor: 3.0 },
  SYMBIOSIS: { key: 'SYMBIOSIS', name: '共生期', description: '完全融合，不分彼此', favorWeight: 0.5, intimacyWeight: 0.5, compositeThreshold: 95, transitionBuffer: 10, intimacyBoostFactor: 1.0 },
};

export interface StageInfo {
  stage: StageKey | null;
  stageName: string;
  description: string;
  compositeScore: number;
  currentStageThreshold: number;
  nextStageThreshold: number | null;
  nextStageName: string;
  isMaxStage: boolean;
  progressToNext: number;
  isTransitioning: boolean;
  intimacyBoostActive: boolean;
  neededIntimacyBoost: number;
}

function nextStageKey(stage: StageKey): StageKey | null {
  const index = STAGE_ORDER.indexOf(stage);
  return index >= 0 && index + 1 < STAGE_ORDER.length ? STAGE_ORDER[index + 1]! : null;
}

/** Raw composite for the stage currently implied by a rough 0.6/0.4 blend. */
function rawComposite(state: EmotionalState): number {
  const rough = state.favor * 0.6 + state.intimacy * 0.4;
  const stage = stageByScore(rough, state);
  const cfg = STAGE_CONFIGS[stage];
  return state.favor * cfg.favorWeight + state.intimacy * cfg.intimacyWeight;
}

function stageByScore(composite: number, state: EmotionalState): StageKey {
  const prevStage: StageKey = (state.prevStageKey as StageKey) ?? 'INITIAL';
  let rawTarget: StageKey;
  if (composite >= STAGE_CONFIGS.SYMBIOSIS.compositeThreshold) rawTarget = 'SYMBIOSIS';
  else if (composite >= STAGE_CONFIGS.COMMITMENT.compositeThreshold) rawTarget = 'COMMITMENT';
  else if (composite >= STAGE_CONFIGS.DEEPENING.compositeThreshold) rawTarget = 'DEEPENING';
  else rawTarget = 'INITIAL';

  const upThreshold = STAGE_CONFIGS[rawTarget].compositeThreshold;
  const downThreshold = upThreshold - 5;
  const useThreshold = STAGE_ORDER.indexOf(rawTarget) > STAGE_ORDER.indexOf(prevStage) ? upThreshold : downThreshold;
  if (composite < useThreshold) return prevStage;
  return rawTarget;
}

function negativeStageInfo(state: EmotionalState): StageInfo {
  const composite = state.favor;
  let stageName: string;
  let description: string;
  let progress: number;
  if (state.favor >= -30) {
    stageName = '冷淡期'; description = '关系冷淡，需要修复';
    progress = Math.max(0, ((state.favor + 30) / 30) * 100);
  } else if (state.favor >= -70) {
    stageName = '反感期'; description = '存在反感情绪';
    progress = Math.max(0, ((state.favor + 70) / 40) * 100);
  } else {
    stageName = '敌对期'; description = '关系敌对'; progress = 0;
  }
  state.prevStageKey = 'INITIAL';
  state.prevComposite = composite;
  state.relationshipStage = stageName as EmotionalState['relationshipStage'];
  state.stageCompositeScore = composite;
  state.stageProgress = Math.max(0, Math.min(100, progress));
  return {
    stage: null, stageName, description, compositeScore: composite,
    currentStageThreshold: 0, nextStageThreshold: null, nextStageName: '恢复正常关系',
    isMaxStage: false, progressToNext: Math.max(0, Math.min(100, progress)),
    isTransitioning: false, intimacyBoostActive: false, neededIntimacyBoost: 0,
  };
}

/** Recompute and persist the stage on `state`; returns full info. */
export function refreshStage(state: EmotionalState): StageInfo {
  if (state.favor < 0) return negativeStageInfo(state);

  const previousStage = state.prevStageKey ?? 'INITIAL';
  const currentComposite = rawComposite(state);
  const targetStage = stageByScore(currentComposite, state);
  const protectedComposite = targetStage !== previousStage ? Math.max(currentComposite, state.prevComposite ?? 0) : currentComposite;
  const cfg = STAGE_CONFIGS[targetStage];

  const needed = cfg.intimacyWeight === 0
    ? 0
    : Math.max(0, Math.min(100, Math.round((protectedComposite - state.favor * cfg.favorWeight) / cfg.intimacyWeight)) - state.intimacy);
  const isTransitioning = previousStage !== targetStage;
  const intimacyBoostActive = needed > 0;

  state.prevStageKey = targetStage;
  state.prevComposite = protectedComposite;
  state.relationshipStage = cfg.name as EmotionalState['relationshipStage'];
  state.stageCompositeScore = protectedComposite;
  state.stageProgress = Math.max(0, Math.min(100, (protectedComposite / cfg.compositeThreshold) * 100));

  const nextKey = nextStageKey(targetStage);
  return {
    stage: targetStage,
    stageName: cfg.name,
    description: cfg.description,
    compositeScore: protectedComposite,
    currentStageThreshold: cfg.compositeThreshold,
    nextStageThreshold: nextKey ? STAGE_CONFIGS[nextKey].compositeThreshold : null,
    nextStageName: nextKey ? STAGE_CONFIGS[nextKey].name : '已达最高阶段',
    isMaxStage: targetStage === 'SYMBIOSIS',
    progressToNext: Math.max(0, Math.min(100, (protectedComposite / cfg.compositeThreshold) * 100)),
    isTransitioning,
    intimacyBoostActive,
    neededIntimacyBoost: needed,
  };
}

/** Transition benefit: amplify intimacy deltas while transitioning. */
export function applyTransitionBenefits(state: EmotionalState, updates: Record<string, number>): Record<string, number> {
  const info = refreshStage(state);
  if (!info.isTransitioning || !info.intimacyBoostActive) return updates;
  const cfg = STAGE_CONFIGS[info.stage ?? 'INITIAL'];
  const boost = cfg.intimacyBoostFactor;
  if (typeof updates['intimacy'] === 'number') {
    updates['intimacy'] = Math.round(updates['intimacy'] * boost);
  } else if (updates['joy'] || updates['trust'] || updates['anticipation']) {
    updates['intimacy'] = Math.max(1, Math.round(2 * boost));
  }
  return updates;
}

export function getStageAdvice(state: EmotionalState): string {
  if (state.favor < 0) {
    if (state.favor >= -30) return '冷淡期：需要真诚道歉和积极行动来修复关系，避免进一步恶化。';
    if (state.favor >= -70) return '反感期：需要时间和耐心来缓解负面情绪，避免直接冲突。';
    return '敌对期：关系极度紧张，需要保持距离或寻求第三方调解。';
  }
  const info = refreshStage(state);
  if (info.isTransitioning && info.intimacyBoostActive) {
    return `【阶段过渡中】${info.stageName}\n当前需要提升亲密度 ${info.neededIntimacyBoost} 点来适应新阶段\n建议: 多进行深度交流，分享个人经历和情感`;
  }
  const advice: Record<StageKey, string> = {
    INITIAL: '初识期：多展示个人魅力，建立良好第一印象。通过有趣的话题和积极的互动提升好感度。',
    DEEPENING: '深化期：分享更多个人经历和情感，建立信任基础。共同经历和深度交流是关键。',
    COMMITMENT: '承诺期：巩固信任和默契，在困难时刻相互支持。关系的深度比广度更重要。',
    SYMBIOSIS: '共生期：维持情感的深度连接，共同成长和创造美好回忆。',
  };
  return advice[info.stage ?? 'INITIAL'] ?? '继续培养这段关系吧！';
}
