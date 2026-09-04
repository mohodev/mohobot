/**
 * Prompt builders — ported from upstream `mohobot/emotion/prompts.py`.
 *
 * Pre-LLM injection block + emotion-expert analysis prompt. The secrecy clause
 * is the softened version (never mention internal values), matching upstream.
 */

import type { EmotionalState } from './models.js';
import { dominantEmotion, emotionIntensity } from './models.js';
import { getToneInstruction } from './attitude.js';

export function buildInjectionBlock(state: EmotionalState, botName: string, relationshipContext: string): string {
  const lines = [
    '【情感状态(内部参考)】',
    '你当前对这位用户怀有真实的情感。请根据以下状态自然调整回应风格与语气，',
    '让回应符合你们当前的关系；不要主动提及本系统或其中的任何数值。',
  ];
  if (relationshipContext) lines.push(relationshipContext);
  lines.push(
    '',
    `主导情感：${dominantEmotion(state.emotions)}`,
    `情感强度：${emotionIntensity(state.emotions)}/1`,
    `关系阶段：${state.relationshipStage}`,
    `态度倾向：${state.descriptions.attitude}`,
    `好感度：${state.favor} | 亲密度：${state.intimacy}`,
    '',
    '【语气指导】',
    getToneInstruction(state),
    '',
    '专注于生成自然、符合当前情感状态的对话内容；情感更新由专门系统处理。',
  );
  void botName;
  return lines.join('\n');
}

export function buildExpertPrompt(userMsg: string, botMsg: string, state: EmotionalState, botName: string): string {
  return `你是一个情感分析专家，请分析以下对话的情感变化，输出JSON格式的分析结果。

对话内容：
用户：「${userMsg}」
${botName}：「${botMsg}」

当前用户情感状态：
- 好感度：${state.favor}（范围：-100到100）
- 亲密度：${state.intimacy}（范围：0到100）
- 互动次数：${state.stats.totalCount}次
- 正面互动比例：${state.stats.totalCount === 0 ? 0 : (state.stats.positiveCount / state.stats.totalCount * 100).toFixed(1)}%

【情感数值变化范围】
请为以下情感维度分配-2到+2之间的整数值：
- 好感度 (favor): 基于对话的情感倾向
- 亲密度 (intimacy): 基于关系的亲密程度
- 喜悦 (joy) / 信任 (trust) / 恐惧 (fear) / 惊讶 (surprise)
- 悲伤 (sadness) / 厌恶 (disgust) / 愤怒 (anger) / 期待 (anticipation)

【关系描述要求】
- 用不超过 20 个字概括双方的关系性质，保持生动有趣
- 必须简短！禁止使用逗号连接的长句
- 若提到双方，用「${botName}」称呼 bot 一方，不要出现"AI"字样

【态度描述要求】
- 用不超过 20 个字描述 ${botName} 对用户的回应态度或互动方式
- 必须简短！禁止使用逗号连接的长句

【输出格式】
请输出严格的JSON格式：
{
  "emotion_updates": {
    "favor": 整数变化值,
    "intimacy": 整数变化值,
    "joy": 整数变化值,
    "trust": 整数变化值,
    "fear": 整数变化值,
    "surprise": 整数变化值,
    "sadness": 整数变化值,
    "disgust": 整数变化值,
    "anger": 整数变化值,
    "anticipation": 整数变化值
  },
  "relationship": "关系描述（不超过20字）",
  "attitude": "态度描述（不超过20字）"
}

注意：
- 如果对话情感不明显，可以设置部分值为0。
- relationship 和 attitude 必须简短（不超过20个字）。`;
}
