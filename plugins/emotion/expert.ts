/**
 * Emotion analysis expert (second LLM) — ported from upstream
 * `mohobot/emotion/expert.py`.
 *
 * Calls a second LLM to analyze one turn's emotional deltas. After 3
 * consecutive failures the LLM is disabled and a keyword fallback takes over.
 * The fallback also runs when no usable provider is configured (offline mode).
 */

import type { EmotionalState } from './models.js';
import {
  EMOTION_FIELDS, EMOTION_DELTA_LIMIT, FAVOR_DELTA_LIMIT,
  ATTITUDE_TEXT_MAX, RELATIONSHIP_TEXT_MAX, clamp,
} from './models.js';
import { buildExpertPrompt } from './prompts.js';

const LLM_MAX_CONSECUTIVE_FAILURES = 3;

export interface ExpertUpdates {
  favor: number;
  intimacy: number;
  joy: number;
  trust: number;
  fear: number;
  surprise: number;
  sadness: number;
  disgust: number;
  anger: number;
  anticipation: number;
  relationshipText?: string;
  attitudeText?: string;
  source: 'llm_analysis' | 'smart_fallback' | 'unknown';
}

export type ExpertLlmCall = (prompt: string) => Promise<string | null>;

export class EmotionExpert {
  #llmAvailable = true;
  #llmFailures = 0;

  constructor(private readonly llmCall: ExpertLlmCall) {}

  resetLlmAvailability(): void {
    this.#llmAvailable = true;
    this.#llmFailures = 0;
  }

  async analyze(userMsg: string, botReply: string, state: EmotionalState, botName: string): Promise<ExpertUpdates> {
    if (this.#llmAvailable && this.llmCall) {
      try {
        const text = await this.llmCall(buildPromptFor(userMsg, botReply, state, botName));
        if (text && text.trim().length > 10) {
          const updates = this.#parse(text);
          updates.source = 'llm_analysis';
          this.#llmFailures = 0;
          return this.#ensureCompleteness(updates, state);
        }
        this.#recordFailure();
      } catch {
        this.#recordFailure();
      }
    }
    const fallback = emptyUpdates();
    const keyword = smartFallback(userMsg, botReply);
    for (const name of ['favor', 'intimacy', ...EMOTION_FIELDS] as const) {
      fallback[name] = typeof keyword[name] === 'number' ? keyword[name] : 0;
    }
    fallback.source = 'smart_fallback';
    return this.#ensureCompleteness(fallback, state);
  }

  #recordFailure(): void {
    this.#llmFailures += 1;
    if (this.#llmFailures >= LLM_MAX_CONSECUTIVE_FAILURES) this.#llmAvailable = false;
  }

  #parse(text: string): ExpertUpdates {
    const cleaned = text.replace(/```(?:json)?\s*/g, '').replace(/\s*```\s*/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('响应中未找到 JSON');
    const data = JSON.parse(fixJson(match[0])) as {
      emotion_updates?: Record<string, unknown>;
      relationship?: unknown;
      attitude?: unknown;
    };
    if (!data.emotion_updates || typeof data.emotion_updates !== 'object') throw new Error('缺少 emotion_updates 字段');
    const raw = data.emotion_updates;
    const updates = emptyUpdates();
    for (const name of ['favor', 'intimacy', ...EMOTION_FIELDS] as const) {
      const value = raw[name];
      const limit = name === 'favor' || name === 'intimacy' ? FAVOR_DELTA_LIMIT : EMOTION_DELTA_LIMIT;
      updates[name] = typeof value === 'number' && Number.isFinite(value) ? clamp(Math.round(value), -limit, limit) : 0;
    }
    updates.relationshipText = String(data.relationship ?? '正常关系').trim().slice(0, RELATIONSHIP_TEXT_MAX);
    updates.attitudeText = String(data.attitude ?? '友好交流').trim().slice(0, ATTITUDE_TEXT_MAX);
    return updates;
  }

  #ensureCompleteness(updates: Partial<ExpertUpdates>, state: EmotionalState): ExpertUpdates {
    const out = emptyUpdates();
    for (const name of ['favor', 'intimacy', ...EMOTION_FIELDS] as const) {
      out[name] = typeof updates[name] === 'number' ? updates[name] : 0;
    }
    out.relationshipText = updates.relationshipText ?? state.descriptions.relationship;
    out.attitudeText = updates.attitudeText ?? state.descriptions.attitude;
    out.source = updates.source ?? 'unknown';
    return out;
  }
}

function emptyUpdates(): ExpertUpdates {
  return {
    favor: 0, intimacy: 0, joy: 0, trust: 0, fear: 0, surprise: 0, sadness: 0, disgust: 0, anger: 0, anticipation: 0,
    source: 'unknown',
  };
}

// The prompt is built here to keep this module self-contained for tests.
function buildPromptFor(userMsg: string, botReply: string, state: EmotionalState, botName: string): string {
  return buildExpertPrompt(userMsg, botReply, state, botName);
}

/** Lenient JSON repair mirroring the upstream `_fix_json_errors`. */
function fixJson(text: string): string {
  let fixed = text.replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3');
  fixed = fixed.replace(/'/g, '"');
  fixed = fixed.replace(/,\s*}/g, '}');
  fixed = fixed.replace(/,\s*]/g, ']');
  const opens = (fixed.match(/{/g) ?? []).length;
  const closes = (fixed.match(/}/g) ?? []).length;
  if (opens > closes) fixed += '}'.repeat(opens - closes);
  return fixed;
}

/** Keyword-weighted numeric fallback (no description text produced). */
export function smartFallback(userMsg: string, botReply: string): Record<string, number> {
  const userLower = (userMsg ?? '').toLowerCase();
  const replyLower = (botReply ?? '').toLowerCase();

  const positive = ['好', '开心', '高兴', '谢谢', '感谢', '喜欢', '爱', '不错', '棒', '可爱', '漂亮', '美丽', '相信'];
  const negative = ['讨厌', '生气', '愤怒', '烦', '恨', '滚', '傻', '笨', '蠢', '垃圾', '不愿意'];
  const intimate = ['想你', '想念', '关心', '担心', '在乎', '重要', '宝贝', '亲爱的', '搞好关系'];

  const count = (words: string[], text: string): number => words.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);
  const pos = count(positive, userLower) * 3 + count(positive, replyLower);
  const neg = count(negative, userLower) * 3 + count(negative, replyLower);
  const intWeight = count(intimate, userLower) * 2 + count(intimate, replyLower);

  if (neg > pos && neg > 0) {
    const strength = Math.min(3, neg);
    return { favor: -strength, intimacy: -1, sadness: 2, anger: 1, disgust: 1 };
  }
  if (pos > neg && pos > 0) {
    const strength = Math.min(3, pos);
    return { favor: strength, intimacy: intWeight > 0 ? 2 : 1, joy: 2, trust: 1, anticipation: 1 };
  }
  if (intWeight > 0) return { favor: 1, intimacy: 3, joy: 2, trust: 2, anticipation: 1 };
  return { favor: 0, intimacy: 0, anticipation: 1 };
}
