/**
 * Relationship stage manager.
 *
 * Ported from carefreesongs712/mohobot `mohobot/emotion/relationship.py`
 * (astrbot-plugin-emotionai_pro). Four advancing stages (初识 → 深化 → 承诺 →
 * 共生) drive a composite score built from favor and intimacy, and negative
 * favor falls into three repair stages instead (冷淡 → 反感 → 敌对).
 *
 * The interesting part is the hysteresis band: going UP needs the full
 * threshold, coming back DOWN only needs threshold-5, so a relationship does
 * not flap between stages on a single bad message. Transitions also grant an
 * intimacy boost, which rewards keeping the conversation going while a
 * relationship settles into its new shape.
 */

import {
  clamp,
  EmotionalState,
  type StageKey,
  STAGE_NAMES,
  STAGE_ORDER,
} from './models.js';

export interface StageConfig {
  name: string;
  description: string;
  favorWeight: number;
  intimacyWeight: number;
  compositeThreshold: number;
  transitionBuffer: number;
  intimacyBoostFactor: number;
}

export const STAGE_CONFIGS: Record<StageKey, StageConfig> = {
  INITIAL: { name: '初识期', description: '好感驱动，建立吸引', favorWeight: 0.7, intimacyWeight: 0.3, compositeThreshold: 25, transitionBuffer: 3, intimacyBoostFactor: 4.0 },
  DEEPENING: { name: '深化期', description: '互动平衡，共同成长', favorWeight: 0.5, intimacyWeight: 0.5, compositeThreshold: 55, transitionBuffer: 5, intimacyBoostFactor: 3.6 },
  COMMITMENT: { name: '承诺期', description: '亲密主导，根基稳固', favorWeight: 0.3, intimacyWeight: 0.7, compositeThreshold: 80, transitionBuffer: 7, intimacyBoostFactor: 3.0 },
  SYMBIOSIS: { name: '共生期', description: '完全融合，不分彼此', favorWeight: 0.5, intimacyWeight: 0.5, compositeThreshold: 95, transitionBuffer: 10, intimacyBoostFactor: 1.0 },
};

export interface TransitionInfo {
  isTransitioning: boolean;
  fromStage: StageKey;
  toStage: StageKey;
  protectedComposite: number;
  intimacyBoostActive: boolean;
  neededIntimacyBoost: number;
}

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

function stageIndex(stage: StageKey): number {
  const index = STAGE_ORDER.indexOf(stage);
  return index === -1 ? 0 : index;
}

export class StageManager {
  /**
   * Chooses the stage for a composite score.
   *
   * Rising needs the full threshold of the stage entered. Falling keeps the
   * current stage until the score drops 5 below *its own* threshold - the
   * hysteresis band a relationship stage needs so one quiet message cannot
   * undo it. (Upstream compares against the target stage's threshold, which
   * makes the band almost never fire; the comment there says this is what the
   * band is for, so this implementation follows the intent.)
   */
  static #getByComposite(composite: number, state: EmotionalState): StageKey {
    const prev = (state.prevStageKey || 'INITIAL') as StageKey;
    let target: StageKey = 'INITIAL';
    if (composite >= STAGE_CONFIGS.SYMBIOSIS.compositeThreshold) target = 'SYMBIOSIS';
    else if (composite >= STAGE_CONFIGS.COMMITMENT.compositeThreshold) target = 'COMMITMENT';
    else if (composite >= STAGE_CONFIGS.DEEPENING.compositeThreshold) target = 'DEEPENING';

    if (stageIndex(target) < stageIndex(prev)) {
      const floor = STAGE_CONFIGS[prev].compositeThreshold - 5;
      if (composite >= floor) return prev;
    }
    return target;
  }

  /** Raw composite for the stage a 0.6/0.4 weighting would select. */
  static #rawComposite(state: EmotionalState): number {
    const rough = state.favor * 0.6 + state.intimacy * 0.4;
    const roughStage = StageManager.#getByComposite(rough, state);
    const cfg = STAGE_CONFIGS[roughStage];
    return state.favor * cfg.favorWeight + state.intimacy * cfg.intimacyWeight;
  }

  static calculateStage(state: EmotionalState): [StageKey, TransitionInfo] {
    const composite = StageManager.#rawComposite(state);
    const previous = (state.prevStageKey || 'INITIAL') as StageKey;
    const target = StageManager.#getByComposite(composite, state);

    const transition: TransitionInfo = {
      isTransitioning: previous !== target,
      fromStage: previous,
      toStage: target,
      protectedComposite: composite,
      intimacyBoostActive: false,
      neededIntimacyBoost: 0,
    };
    if (transition.isTransitioning) {
      // Keep the higher of now/then so a brief dip cannot undo progress.
      const protectedComposite = Math.max(composite, state.prevComposite);
      transition.protectedComposite = protectedComposite;
      transition.neededIntimacyBoost = StageManager.#neededIntimacy(state, STAGE_CONFIGS[target], protectedComposite);
      transition.intimacyBoostActive = transition.neededIntimacyBoost > 0;
    }
    return [target, transition];
  }

  static #neededIntimacy(state: EmotionalState, target: StageConfig, protectedComposite: number): number {
    if (target.intimacyWeight === 0) return 0;
    const needed = (protectedComposite - state.favor * target.favorWeight) / target.intimacyWeight;
    return Math.max(0, clamp(needed, 0, 100) - state.intimacy);
  }

  /** Full stage snapshot. Mutates the state's cached stage fields. */
  static getStageInfo(state: EmotionalState): StageInfo {
    if (state.favor < 0) return StageManager.#negativeStageInfo(state);

    const [target, transition] = StageManager.calculateStage(state);
    const cfg = STAGE_CONFIGS[target];
    const composite = transition.protectedComposite;

    const nextKey = stageIndex(target) + 1 < STAGE_ORDER.length ? STAGE_ORDER[stageIndex(target) + 1]! : undefined;
    const nextThreshold = nextKey ? STAGE_CONFIGS[nextKey].compositeThreshold : null;
    const nextName = nextKey ? STAGE_CONFIGS[nextKey].name : '已达最高阶段';

    const progress = (composite / cfg.compositeThreshold) * 100;
    state.prevStageKey = target;
    state.prevComposite = composite;
    state.relationshipStage = cfg.name;
    state.stageCompositeScore = composite;
    state.stageProgress = clamp(progress, 0, 100);

    return {
      stage: target,
      stageName: cfg.name,
      description: cfg.description,
      compositeScore: composite,
      currentStageThreshold: cfg.compositeThreshold,
      nextStageThreshold: nextThreshold,
      nextStageName: nextName,
      isMaxStage: target === 'SYMBIOSIS',
      progressToNext: clamp(progress, 0, 100),
      isTransitioning: transition.isTransitioning,
      intimacyBoostActive: transition.intimacyBoostActive,
      neededIntimacyBoost: transition.neededIntimacyBoost,
    };
  }

  static #negativeStageInfo(state: EmotionalState): StageInfo {
    let stageName: string;
    let description: string;
    let progress: number;
    if (state.favor >= -30) {
      stageName = STAGE_NAMES.COLD!;
      description = '关系冷淡，需要修复';
      progress = ((state.favor + 30) / 30) * 100;
    } else if (state.favor >= -70) {
      stageName = STAGE_NAMES.DISLIKE!;
      description = '存在反感情绪';
      progress = ((state.favor + 70) / 40) * 100;
    } else {
      stageName = STAGE_NAMES.HOSTILE!;
      description = '关系敌对';
      progress = 0;
    }

    const composite = state.favor;
    state.prevStageKey = 'INITIAL';
    state.prevComposite = composite;
    state.relationshipStage = stageName;
    state.stageCompositeScore = composite;
    state.stageProgress = clamp(progress, 0, 100);

    return {
      stage: null,
      stageName,
      description,
      compositeScore: composite,
      currentStageThreshold: 0,
      nextStageThreshold: null,
      nextStageName: '恢复正常关系',
      isMaxStage: false,
      progressToNext: clamp(progress, 0, 100),
      isTransitioning: false,
      intimacyBoostActive: false,
      neededIntimacyBoost: 0,
    };
  }

  /**
   * Transition bonus: while a stage change needs intimacy to settle, intimacy
   * gains are multiplied and positive moods add a little intimacy for free.
   */
  static applyTransitionBenefits(state: EmotionalState, updates: Record<string, number>): Record<string, number> {
    const [, transition] = StageManager.calculateStage(state);
    if (!transition.intimacyBoostActive) return updates;
    const boost = STAGE_CONFIGS[transition.toStage].intimacyBoostFactor;
    const out = { ...updates };
    if ('intimacy' in out) out.intimacy = Math.trunc(out.intimacy * boost);
    else if (['joy', 'trust', 'anticipation'].some((field) => typeof out[field] === 'number')) {
      out.intimacy = (out.intimacy ?? 0) + Math.max(1, Math.trunc(2 * boost));
    }
    return out;
  }

  /** Human-readable advice shown by the stage command. */
  static getStageAdvice(state: EmotionalState): string {
    if (state.favor < 0) {
      if (state.favor >= -30) return '冷淡期：需要真诚道歉和积极行动来修复关系，避免进一步恶化。';
      if (state.favor >= -70) return '反感期：需要时间和耐心来缓解负面情绪，避免直接冲突。';
      return '敌对期：关系极度紧张，需要保持距离或寻求第三方调解。';
    }
    const info = StageManager.getStageInfo(state);
    if (info.isTransitioning && info.intimacyBoostActive) {
      return `【阶段过渡中】${info.stageName}\n当前需要提升亲密度 ${info.neededIntimacyBoost} 点来适应新阶段\n建议: 多进行深度交流，分享个人经历和情感`;
    }
    const advice: Record<StageKey, string> = {
      INITIAL: '初识期：多展示个人魅力，建立良好第一印象。通过有趣的话题和积极的互动提升好感度。',
      DEEPENING: '深化期：分享更多个人经历和情感，建立信任基础。共同经历和深度交流是关键。',
      COMMITMENT: '承诺期：巩固信任和默契，在困难时刻相互支持。关系的深度比广度更重要。',
      SYMBIOSIS: '共生期：维持情感的深度连接，共同成长和创造美好回忆。',
    };
    return advice[(info.stage ?? 'INITIAL') as StageKey] ?? '继续培养这段关系吧！';
  }
}
