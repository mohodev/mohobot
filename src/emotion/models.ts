/**
 * Emotion data model — per-user relationship state.
 *
 * Ported from carefreesongs712/mohobot `mohobot/emotion/models.py`
 * (astrbot-plugin-emotionai_pro). Two scalar values carry the relationship:
 *   favor    (-100..100) how much the character likes you
 *   intimacy (0..100)   how close the two of you are
 * on top of an eight-dimension mood, interaction counters and the short
 * AI-written descriptions that get injected into the reply prompt.
 *
 * Every number is clamped on read and write: malformed persisted state can
 * never throw, it degrades to a sane default.
 */

export const MIN_FAVOR = -100;
export const MAX_FAVOR = 100;
export const MIN_INTIMACY = 0;
export const MAX_INTIMACY = 100;
export const MIN_EMOTION = 0;
export const MAX_EMOTION = 100;

/** Per-analysis deltas are capped so one turn cannot swing the relationship. */
export const FAVOR_DELTA_LIMIT = 5;
export const EMOTION_DELTA_LIMIT = 3;

/** AI-written description length (also enforced by the expert prompt). */
export const ATTITUDE_TEXT_MAX = 20;
export const RELATIONSHIP_TEXT_MAX = 20;

const THIRTY_MINUTES_MS = 30 * 60_000;
const ONE_DAY_MS = 24 * 60 * 60_000;

export const EMOTION_FIELDS = ['joy', 'trust', 'fear', 'surprise', 'sadness', 'disgust', 'anger', 'anticipation'] as const;
export type EmotionField = (typeof EMOTION_FIELDS)[number];

export const EMOTION_NAMES: Record<EmotionField, string> = {
  joy: '喜悦', trust: '信任', fear: '恐惧', surprise: '惊讶',
  sadness: '悲伤', disgust: '厌恶', anger: '愤怒', anticipation: '期待',
};

/** Positive relationship stages, in progression order. */
export const STAGE_ORDER = ['INITIAL', 'DEEPENING', 'COMMITMENT', 'SYMBIOSIS'] as const;
export type StageKey = (typeof STAGE_ORDER)[number];

export const NEGATIVE_STAGES = ['COLD', 'DISLIKE', 'HOSTILE'] as const;
export type NegativeStageKey = (typeof NEGATIVE_STAGES)[number];

export const STAGE_NAMES: Record<string, string> = {
  INITIAL: '初识期', DEEPENING: '深化期', COMMITMENT: '承诺期', SYMBIOSIS: '共生期',
  COLD: '冷淡期', DISLIKE: '反感期', HOSTILE: '敌对期',
};

export function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, Math.round(value)));
}

function clampEmotion(value: number): number {
  return clamp(value, MIN_EMOTION, MAX_EMOTION);
}

/** Eight mood dimensions. 0..100 each, updated by small signed deltas. */
export class EmotionalMetrics {
  joy = 0;
  trust = 0;
  fear = 0;
  surprise = 0;
  sadness = 0;
  disgust = 0;
  anger = 0;
  anticipation = 0;

  /** Applies deltas, ignoring unknown fields and clamping each dimension. */
  applyUpdate(updates: Record<string, number>): void {
    for (const field of EMOTION_FIELDS) {
      const delta = updates[field];
      if (typeof delta !== 'number' || !Number.isFinite(delta)) continue;
      this[field] = clampEmotion(this[field] + Math.trunc(delta));
    }
  }

  /** Highest mood, or a composite label when several tie. */
  getDominant(): string {
    const values: Array<[string, number]> = EMOTION_FIELDS.map((field) => [EMOTION_NAMES[field]!, this[field]]);
    const max = Math.max(...values.map(([, v]) => v));
    if (max <= 0) return '中立';
    const leaders = values.filter(([, v]) => v === max).map(([name]) => name);
    return leaders.length === 1 ? leaders[0]! : `复合(${leaders.join('+')})`;
  }

  maxValue(): number {
    return Math.max(...EMOTION_FIELDS.map((field) => this[field]));
  }

  toDict(): Record<EmotionField, number> {
    const out = {} as Record<EmotionField, number>;
    for (const field of EMOTION_FIELDS) out[field] = this[field];
    return out;
  }

  static fromDict(data: Record<string, unknown> | undefined): EmotionalMetrics {
    const metrics = new EmotionalMetrics();
    for (const field of EMOTION_FIELDS) {
      const raw = data?.[field];
      metrics[field] = typeof raw === 'number' && Number.isFinite(raw) ? clampEmotion(raw) : 0;
    }
    return metrics;
  }
}

/** Interaction counters; `positive` is decided after each analysis. */
export class InteractionStats {
  totalCount = 0;
  positiveCount = 0;
  negativeCount = 0;
  lastInteractionTime = 0;

  record(positive: boolean, now = Date.now()): void {
    this.totalCount += 1;
    if (positive) this.positiveCount += 1;
    else this.negativeCount += 1;
    this.lastInteractionTime = now;
  }

  get positiveRatio(): number {
    return this.totalCount === 0 ? 0 : (this.positiveCount / this.totalCount) * 100;
  }

  /** Days since the last interaction; `now` is injectable for deterministic tests. */
  daysSinceLast(now: number = Date.now()): number {
    if (!this.lastInteractionTime) return Number.POSITIVE_INFINITY;
    return (now - this.lastInteractionTime) / ONE_DAY_MS;
  }

  toDict(): { totalCount: number; positiveCount: number; negativeCount: number; lastInteractionTime: number } {
    return { totalCount: this.totalCount, positiveCount: this.positiveCount, negativeCount: this.negativeCount, lastInteractionTime: this.lastInteractionTime };
  }

  static fromDict(data: Record<string, unknown> | undefined): InteractionStats {
    const stats = new InteractionStats();
    stats.totalCount = nonNegativeInt(data?.totalCount);
    stats.positiveCount = nonNegativeInt(data?.positiveCount);
    stats.negativeCount = nonNegativeInt(data?.negativeCount);
    if (stats.positiveCount + stats.negativeCount > stats.totalCount) stats.totalCount = stats.positiveCount + stats.negativeCount;
    stats.lastInteractionTime = typeof data?.lastInteractionTime === 'number' && Number.isFinite(data.lastInteractionTime) ? Math.max(0, data.lastInteractionTime) : 0;
    return stats;
  }
}

/**
 * Short AI-written attitude / relationship blurbs. Only a real LLM analysis
 * (`source === 'llm_analysis'`) is allowed to overwrite them, and the text is
 * validated so injected junk cannot poison the prompt.
 */
const DESCRIPTION_PATTERN = /^[\w\-\s\u4e00-\u9fa5\uff0c\u3002\uff01\uff1f\u3001\uff1b\uff1a\u201c\u201d\u2018\u2019\u300a\u300b\u00b7]{1,50}$/;

export class TextDescriptions {
  attitude = '中立';
  relationship = '陌生人';
  lastAttitudeUpdate = 0;
  lastRelationshipUpdate = 0;

  static isValid(text: string): boolean {
    return Boolean(text) && DESCRIPTION_PATTERN.test(text);
  }

  updateAttitude(text: string, now: number = Date.now()): boolean {
    if (!TextDescriptions.isValid(text)) return false;
    this.attitude = text;
    this.lastAttitudeUpdate = now;
    return true;
  }

  updateRelationship(text: string, now: number = Date.now()): boolean {
    if (!TextDescriptions.isValid(text)) return false;
    this.relationship = text;
    this.lastRelationshipUpdate = now;
    return true;
  }

  toDict(): { attitude: string; relationship: string; lastAttitudeUpdate: number; lastRelationshipUpdate: number } {
    return { attitude: this.attitude, relationship: this.relationship, lastAttitudeUpdate: this.lastAttitudeUpdate, lastRelationshipUpdate: this.lastRelationshipUpdate };
  }

  static fromDict(data: Record<string, unknown> | undefined): TextDescriptions {
    const descriptions = new TextDescriptions();
    descriptions.attitude = typeof data?.attitude === 'string' && TextDescriptions.isValid(data.attitude) ? data.attitude : '中立';
    descriptions.relationship = typeof data?.relationship === 'string' && TextDescriptions.isValid(data.relationship) ? data.relationship : '陌生人';
    descriptions.lastAttitudeUpdate = finiteOrZero(data?.lastAttitudeUpdate);
    descriptions.lastRelationshipUpdate = finiteOrZero(data?.lastRelationshipUpdate);
    return descriptions;
  }
}

/** One user's full emotional state, isolated per bot. */
export class EmotionalState {
  userKey = '';
  favor = 0;
  intimacy = 0;
  emotions = new EmotionalMetrics();
  stats = new InteractionStats();
  descriptions = new TextDescriptions();

  relationshipStage = '初识期';
  stageCompositeScore = 0;
  /** Percentage progress toward the next stage (0..100). */
  stageProgress = 0;

  /** Rounds since the last analysis, plus wall-clock for the interval gate. */
  forceUpdateCounter = 0;
  lastForceUpdate = 0;

  /** Hysteresis memory: last decided stage and score (never persisted). */
  prevStageKey = 'INITIAL';
  prevComposite = 0;

  constructor(userKey = '') {
    this.userKey = userKey;
    if (this.relationshipStage === '') this.relationshipStage = STAGE_NAMES.INITIAL!;
  }

  /** Mirror of upstream: force analysis every N rounds or every hour. */
  shouldForceUpdate(forceInterval: number, now: number = Date.now()): boolean {
    if (this.forceUpdateCounter >= Math.max(1, Math.trunc(forceInterval))) return true;
    return this.lastForceUpdate > 0 && now - this.lastForceUpdate > 60 * 60_000;
  }

  resetForceUpdateCounter(now: number = Date.now()): void {
    this.forceUpdateCounter = 0;
    this.lastForceUpdate = now;
  }

  get isInitial(): boolean {
    return this.favor === 0 && this.intimacy === 0 && this.stats.totalCount === 0 && this.relationshipStage === STAGE_NAMES.INITIAL;
  }

  toDict(): Record<string, unknown> {
    return {
      user_key: this.userKey,
      favor: this.favor,
      intimacy: this.intimacy,
      emotions: this.emotions.toDict(),
      stats: this.stats.toDict(),
      descriptions: this.descriptions.toDict(),
      relationship_stage: this.relationshipStage,
      stage_composite_score: this.stageCompositeScore,
      stage_progress: this.stageProgress,
      force_update_counter: this.forceUpdateCounter,
      last_force_update: this.lastForceUpdate,
    };
  }

  static fromDict(data: Record<string, unknown> | undefined): EmotionalState {
    const state = new EmotionalState(typeof data?.user_key === 'string' ? data.user_key : '');
    state.favor = clamp(finiteNumber(data?.favor), MIN_FAVOR, MAX_FAVOR);
    state.intimacy = clamp(finiteNumber(data?.intimacy), MIN_INTIMACY, MAX_INTIMACY);
    state.emotions = EmotionalMetrics.fromDict(asRecord(data?.emotions));
    state.stats = InteractionStats.fromDict(asRecord(data?.stats));
    state.descriptions = TextDescriptions.fromDict(asRecord(data?.descriptions));
    const stage = typeof data?.relationship_stage === 'string' ? data.relationship_stage : '';
    state.relationshipStage = Object.values(STAGE_NAMES).includes(stage) ? stage : STAGE_NAMES.INITIAL!;
    state.stageCompositeScore = finiteNumber(data?.stage_composite_score);
    state.stageProgress = clamp(finiteNumber(data?.stage_progress), 0, 100);
    state.forceUpdateCounter = nonNegativeInt(data?.force_update_counter);
    state.lastForceUpdate = finiteOrZero(data?.last_force_update);
    return state;
  }
}

/** One important interaction kept for the long-term relationship timeline. */
export interface InteractionRecord {
  userMsg: string;
  aiResponse: string;
  timestamp: number;
  significance: number;
  emotionalChanges: Record<string, number>;
}

function nonNegativeInt(value: unknown): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.trunc(parsed));
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function finiteOrZero(value: unknown): number {
  return Math.max(0, finiteNumber(value));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export const EMOTION_TIME = { THIRTY_MINUTES_MS, ONE_DAY_MS };
