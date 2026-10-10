/**
 * Prompts for the second-pass emotion analyst.
 *
 * Ported from carefreesongs712/mohobot `mohobot/emotion/prompts.py`. The expert
 * sees only the two turns and the current counters, and must answer with strict
 * JSON of *deltas* (never absolute values) so the application layer keeps the
 * authority over ranges and clamping.
 */

import { EMOTION_FIELDS, EMOTION_NAMES, type EmotionalState } from './models.js';

export function buildExpertPrompt(userMsg: string, botMsg: string, state: EmotionalState, botName: string): string {
  const dimensionLines = EMOTION_FIELDS.map((field) => `${field} (${EMOTION_NAMES[field]})`).join(' / ');
  return [
    '你是一个情感分析专家，请分析以下对话的情感变化，输出JSON格式的分析结果。',
    '',
    '对话内容：',
    `用户:「${userMsg}」`,
    `${botName}:「${botMsg}」`,
    '',
    '当前用户情感状态：',
    `- 好感度：${state.favor}（范围：-100到100）`,
    `- 亲密度：${state.intimacy}（范围：0到100）`,
    `- 互动次数：${state.stats.totalCount}次`,
    `- 正面互动比例：${state.stats.positiveRatio.toFixed(1)}%`,
    '',
    '【情感数值变化范围】',
    '请为以下情感维度分配-2到+2之间的整数值：',
    dimensionLines,
    '',
    '【关系描述要求】',
    '用不超过 20 个字概括双方的关系性质，保持生动有趣',
    '必须简短！禁止使用逗号连接的长句',
    `若提到双方，用「${botName}」称呼 bot 一方，不要出现"AI"字样`,
    '',
    '【态度描述要求】',
    `用不超过 20 个字描述 ${botName} 对用户的回应态度或互动方式`,
    '必须简短！禁止使用逗号连接的长句',
    '',
    '【输出格式】',
    '请输出严格的JSON格式：',
    '{',
    '  "emotion_updates": {',
    ...EMOTION_FIELDS.map((field) => `    "${field}": 整数变化值,`),
    '  },',
    '  "relationship": "关系描述（不超过20字）",',
    '  "attitude": "态度描述（不超过20字）"',
    '}',
    '',
    '注意：如果对话情感不明显，可以设置部分值为0。relationship 和 attitude 必须简短（不超过20个字）。',
  ].join('\n');
}
