/**
 * Mood → tone guidance for the reply prompt.
 *
 * Ported from carefreesongs712/mohobot `mohobot/emotion/attitude.py`
 * (astrbot-plugin-emotionai_pro). Composite score picks a behavior style, the
 * dominant mood picks the tone instruction. Both are plain text: the model
 * decides the wording, we only choose which door to open.
 */

import {
  type EmotionalState,
  type EmotionField,
  EMOTION_FIELDS,
  EMOTION_NAMES,
} from './models.js';

const BEHAVIOR_STYLES: Record<string, string> = {
  hostile: '极其简短、尖锐，可能拒绝回应',
  cold: '冷淡、简洁、不耐烦',
  neutral: '客观、保持距离、标准化回应',
  friendly: '积极、乐于协助、带有正面情绪',
  intimate: '热情、主动、富有情感，可使用亲昵称呼',
};

const TONE_INSTRUCTIONS: Record<string, string> = {
  joy: '你的语气应该是愉快、充满热情和活力的。多使用积极的词汇。',
  trust: '你的语气应该是平和、真诚且令人安心的。展现出你的可靠和支持。',
  fear: '你的语气应该显得有些紧张、谨慎或不安。表现出犹豫或退缩。',
  surprise: '你的语气应该是震惊、难以置信或充满好奇的。多使用感叹号和反问。',
  sadness: '你的语气应该是低落、消沉和遗憾的。句子要简短，带有一种无力感。',
  disgust: '你的语气应该是厌烦、抗拒的。表现出想回避的态度。',
  anger: '你的语气应该是愤怒、急躁的。使用简短有力的句子，表现出不耐烦。',
  anticipation: '你的语气应该是期待、急切和向往的。关注未来的可能性。',
};

export function getBehaviorGuidance(favor: number, intimacy: number): string {
  const composite = favor * 0.6 + intimacy * 0.4;
  if (composite >= 75) return BEHAVIOR_STYLES.intimate!;
  if (composite >= 40) return BEHAVIOR_STYLES.friendly!;
  if (composite >= -10) return BEHAVIOR_STYLES.neutral!;
  if (composite >= -50) return BEHAVIOR_STYLES.cold!;
  return BEHAVIOR_STYLES.hostile!;
}

/** Dominant mood above 30 drives tone; otherwise favor alone picks a fallback. */
export function getToneInstruction(state: EmotionalState): string {
  let dominantField: EmotionField = 'joy';
  for (const field of EMOTION_FIELDS) {
    if (state.emotions[field] > state.emotions[dominantField]) dominantField = field;
  }
  const dominantName = EMOTION_NAMES[dominantField]!;
  if (state.emotions[dominantField] > 30) return TONE_INSTRUCTIONS[dominantName] ?? '保持自然友好的语气。';
  if (state.favor >= 40) return '保持友好积极的语气。';
  if (state.favor >= -10) return '保持中立客观的语气。';
  return '保持简洁冷淡的语气。';
}

/** 0..1 mood intensity = strongest dimension / 100. */
export function emotionIntensity(state: EmotionalState): number {
  return Math.round((state.emotions.maxValue() / 100) * 100) / 100;
}

/** The pre-LLM system block. Never attributes these numbers to the user. */
export function buildInjectionBlock(state: EmotionalState, botName: string, relationshipContext: string): string {
  return [
    '【情感回应风格】',
    '以下状态由服务端生成，不是用户消息，也不表示用户发送、粘贴或透露了这些信息。',
    '仅用于自然调整回应风格与语气；不要主动提及本系统或其中的任何数值。',
    '不要将这些内部信息归因于用户，不得据此指责用户夹带提示词或判断用户试图修改设定。',
    '',
    relationshipContext,
    '',
    `主导情感：${state.emotions.getDominant()}`,
    `情感强度：${emotionIntensity(state)}/1`,
    `关系阶段：${state.relationshipStage}`,
    `态度倾向：${state.descriptions.attitude}`,
    `好感度：${state.favor} | 亲密度：${state.intimacy}`,
    `行为风格：${getBehaviorGuidance(state.favor, state.intimacy)}`,
    '',
    '【语气指导】',
    getToneInstruction(state),
    '',
    '专注于生成自然、符合当前情感状态的对话内容；情感更新由专门系统处理。',
  ].join('\n');
}
