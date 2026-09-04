/**
 * Emotion data models — ported from upstream carefreesongs712/mohobot
 * `mohobot/emotion/models.py` (astrbot-plugin-emotionai_pro lineage).
 *
 * Per-user emotional state: favor (-100..100), intimacy (0..100), 8 emotion
 * dimensions, interaction stats, AI-generated attitude/relationship text and a
 * relationship stage. Out-of-range values are silently clamped.
 */

export const MIN_FAVOR = -100;
export const MAX_FAVOR = 100;
export const MIN_INTIMACY = 0;
export const MAX_INTIMACY = 100;
export const MIN_EMOTION = 0;
export const MAX_EMOTION = 100;

/** Expert single-call delta caps (upstream hardcodes ±5/±3). */
export const FAVOR_DELTA_LIMIT = 5;
export const EMOTION_DELTA_LIMIT = 3;
export const ATTITUDE_TEXT_MAX = 20;
export const RELATIONSHIP_TEXT_MAX = 20;

export const EMOTION_FIELDS = ['joy', 'trust', 'fear', 'surprise', 'sadness', 'disgust', 'anger', 'anticipation'] as const;
export type EmotionField = (typeof EMOTION_FIELDS)[number];
export type EmotionMetrics = Record<EmotionField, number>;

export const EMOTION_NAMES: Record<EmotionField, string> = {
  joy: '喜悦', trust: '信任', fear: '恐惧', surprise: '惊讶',
  sadness: '悲伤', disgust: '厌恶', anger: '愤怒', anticipation: '期待',
};

export const STAGE_ORDER = ['INITIAL', 'DEEPENING', 'COMMITMENT', 'SYMBIOSIS'] as const;
export type StageKey = (typeof STAGE_ORDER)[number];

export const STAGE_NAMES: Record<StageKey, string> = {
  INITIAL: '初识期', DEEPENING: '深化期', COMMITMENT: '承诺期', SYMBIOSIS: '共生期',
};

export const NEGATIVE_STAGES = { COLD: '冷淡期', DISLIKE: '反感期', HOSTILE: '敌对期' } as const;
export type NegativeStage = (typeof NEGATIVE_STAGES)[keyof typeof NEGATIVE_STAGES];
export type StageName = StageKey extends never ? never : (typeof STAGE_NAMES)[StageKey] | NegativeStage;

export interface InteractionStats {
  totalCount: number;
  positiveCount: number;
  negativeCount: number;
  lastInteractionAt: number;
}

export interface TextDescriptions {
  attitude: string;
  relationship: string;
  lastAttitudeUpdate: number;
  lastRelationshipUpdate: number;
}

export interface EmotionalState {
  favor: number;
  intimacy: number;
  emotions: EmotionMetrics;
  stats: InteractionStats;
  descriptions: TextDescriptions;
  relationshipStage: StageName;
  stageCompositeScore: number;
  stageProgress: number;
  forceUpdateCounter: number;
  lastForceUpdate: number;
  /** Runtime-only (not serialized): previous stage used for hysteresis. */
  prevStageKey?: StageKey | 'INITIAL';
  prevComposite?: number;
}

export function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

export function defaultEmotions(): EmotionMetrics {
  return { joy: 0, trust: 0, fear: 0, surprise: 0, sadness: 0, disgust: 0, anger: 0, anticipation: 0 };
}

export function defaultState(): EmotionalState {
  return {
    favor: 0,
    intimacy: 0,
    emotions: defaultEmotions(),
    stats: { totalCount: 0, positiveCount: 0, negativeCount: 0, lastInteractionAt: 0 },
    descriptions: { attitude: '中立', relationship: '陌生人', lastAttitudeUpdate: 0, lastRelationshipUpdate: 0 },
    relationshipStage: '初识期',
    stageCompositeScore: 0,
    stageProgress: 0,
    forceUpdateCounter: 0,
    lastForceUpdate: 0,
    prevStageKey: 'INITIAL',
    prevComposite: 0,
  };
}

/** Apply one emotion dimension delta, clamped. */
export function applyEmotion(emotions: EmotionMetrics, updates: Partial<EmotionMetrics>): void {
  for (const field of EMOTION_FIELDS) {
    const delta = updates[field];
    if (typeof delta !== 'number' || !Number.isFinite(delta)) continue;
    emotions[field] = clamp(Math.round(emotions[field] + delta), MIN_EMOTION, MAX_EMOTION);
  }
}

/** Dominant emotion label; ties become a composite description. */
export function dominantEmotion(emotions: EmotionMetrics): string {
  let max = 0;
  for (const field of EMOTION_FIELDS) max = Math.max(max, emotions[field]);
  if (max === 0) return '中立';
  const dominant = EMOTION_FIELDS.filter((f) => emotions[f] === max);
  if (dominant.length === 1) return EMOTION_NAMES[dominant[0]!];
  return `复合(${dominant.map((f) => EMOTION_NAMES[f]).join('+')})`;
}

/** Emotion intensity 0..1 = strongest dimension / 100. */
export function emotionIntensity(emotions: EmotionMetrics): number {
  let max = 0;
  for (const field of EMOTION_FIELDS) max = Math.max(max, emotions[field]);
  return Math.round((max / 100) * 100) / 100;
}

/** Wire format: excludes the runtime-only hysteresis fields. */
export function serializeState(state: EmotionalState): Record<string, unknown> {
  return {
    favor: state.favor,
    intimacy: state.intimacy,
    emotions: { ...state.emotions },
    stats: { ...state.stats },
    descriptions: { ...state.descriptions },
    relationshipStage: state.relationshipStage,
    stageCompositeScore: state.stageCompositeScore,
    stageProgress: state.stageProgress,
    forceUpdateCounter: state.forceUpdateCounter,
    lastForceUpdate: state.lastForceUpdate,
  };
}

export function deserializeState(raw: unknown): EmotionalState {
  const base = defaultState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const row = raw as Record<string, unknown>;
  const favor = typeof row.favor === 'number' && Number.isFinite(row.favor) ? Math.round(row.favor) : 0;
  const intimacy = typeof row.intimacy === 'number' && Number.isFinite(row.intimacy) ? Math.round(row.intimacy) : 0;
  const emotions = defaultEmotions();
  const rawEmotions = (row.emotions ?? {}) as Record<string, unknown>;
  for (const field of EMOTION_FIELDS) {
    const value = rawEmotions[field];
    emotions[field] = typeof value === 'number' && Number.isFinite(value) ? clamp(Math.round(value), MIN_EMOTION, MAX_EMOTION) : 0;
  }
  const stats = (row.stats ?? {}) as Record<string, unknown>;
  const descriptions = (row.descriptions ?? {}) as Record<string, unknown>;
  return {
    ...base,
    favor: clamp(favor, MIN_FAVOR, MAX_FAVOR),
    intimacy: clamp(intimacy, MIN_INTIMACY, MAX_INTIMACY),
    emotions,
    stats: {
      totalCount: Math.max(0, Math.round(Number(stats.totalCount) || 0)),
      positiveCount: Math.max(0, Math.round(Number(stats.positiveCount) || 0)),
      negativeCount: Math.max(0, Math.round(Number(stats.negativeCount) || 0)),
      lastInteractionAt: Math.max(0, Number(stats.lastInteractionAt) || 0),
    },
    descriptions: {
      attitude: cleanText(String(descriptions.attitude ?? '中立'), '中立'),
      relationship: cleanText(String(descriptions.relationship ?? '陌生人'), '陌生人'),
      lastAttitudeUpdate: Math.max(0, Number(descriptions.lastAttitudeUpdate) || 0),
      lastRelationshipUpdate: Math.max(0, Number(descriptions.lastRelationshipUpdate) || 0),
    },
    relationshipStage: normalizeStage(String(row.relationshipStage ?? '初识期'), favor),
    stageCompositeScore: Number(row.stageCompositeScore) || 0,
    stageProgress: Number(row.stageProgress) || 0,
    forceUpdateCounter: Math.max(0, Math.round(Number(row.forceUpdateCounter) || 0)),
    lastForceUpdate: Math.max(0, Number(row.lastForceUpdate) || 0),
  };
}

function cleanText(text: string, fallback: string): string {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 50) return fallback;
  return trimmed;
}

const VALID_STAGE_NAMES = new Set<string>([
  '初识期', '深化期', '承诺期', '共生期', '冷淡期', '反感期', '敌对期',
]);

function normalizeStage(stage: string, favor: number): StageName {
  if (VALID_STAGE_NAMES.has(stage)) return stage as StageName;
  if (favor < -70) return '敌对期';
  if (favor < -30) return '反感期';
  if (favor < 0) return '冷淡期';
  return '初识期';
}
