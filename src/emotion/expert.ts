/**
 * Second-pass emotion analyst.
 *
 * Ported from carefreesongs712/mohobot `mohobot/emotion/expert.py`
 * (astrbot-plugin-emotionai_pro). After every reply a cheap LLM call scores how
 * the turn changed the relationship; a circuit breaker falls back to keyword
 * heuristics when that model keeps failing, so a flaky analysis model degrades
 * the *update quality* and never the conversation itself.
 */

import {
  EMOTION_DELTA_LIMIT,
  EMOTION_FIELDS,
  EmotionalState,
  FAVOR_DELTA_LIMIT,
  RELATIONSHIP_TEXT_MAX,
  ATTITUDE_TEXT_MAX,
} from './models.js';
import { buildExpertPrompt } from './prompts.js';

/** Consecutive LLM failures before switching to keyword fallback. */
const LLM_MAX_CONSECUTIVE_FAILURES = 3;
/** Cooling period before a half-open probe is allowed. */
const LLM_CIRCUIT_COOLDOWN_MS = 5 * 60_000;

export type EmotionAnalysisSource = 'llm_analysis' | 'smart_fallback' | 'unknown';

export interface EmotionUpdates {
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
  relationshipText: string;
  attitudeText: string;
  source: EmotionAnalysisSource;
}

export interface EmotionExpertOptions {
  /** Injectable model call. Returns the raw assistant text, or null when empty. */
  chat: (prompt: string, model?: string) => Promise<string | null>;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  /** Injectable clock/sleep for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable logger-ish warn hook; never throws. */
  onWarn?: (message: string, detail?: unknown) => void;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class EmotionExpert {
  readonly #chat: (prompt: string, model?: string) => Promise<string | null>;
  readonly #timeoutMs: number;
  readonly #retries: number;
  readonly #retryDelayMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #onWarn: (message: string, detail?: unknown) => void;

  #llmAvailable = true;
  #consecutiveFailures = 0;
  /** When the circuit last opened; only meaningful while `#tripped`. */
  #trippedAt = 0;
  #tripped = false;

  constructor(options: EmotionExpertOptions) {
    this.#chat = options.chat;
    this.#timeoutMs = options.timeoutMs ?? 90_000;
    this.#retries = Math.max(1, options.retries ?? 2);
    this.#retryDelayMs = options.retryDelayMs ?? 1_000;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#onWarn = options.onWarn ?? (() => {});
  }

  get llmAvailable(): boolean { return this.#llmAvailable; }

  /** Circuit snapshot for the admin panel. */
  status(): { llmAvailable: boolean; consecutiveFailures: number; tripped: boolean; cooldownRemainingMs: number } {
    const cooldownRemainingMs = this.#tripped ? Math.max(0, LLM_CIRCUIT_COOLDOWN_MS - (this.#now() - this.#trippedAt)) : 0;
    return { llmAvailable: this.#llmAvailable, consecutiveFailures: this.#consecutiveFailures, tripped: this.#tripped, cooldownRemainingMs };
  }

  resetLlmAvailability(): void {
    this.#llmAvailable = true;
    this.#consecutiveFailures = 0;
    this.#trippedAt = 0;
    this.#tripped = false;
  }

  /** Full analysis for one turn. Never throws: failures degrade to keywords. */
  async analyze(userMsg: string, botReply: string, state: EmotionalState, botName = 'AI', model?: string): Promise<EmotionUpdates> {
    this.#maybeHalfOpen();
    try {
      if (this.#llmAvailable) {
        const text = await this.#callLlmWithRetry(userMsg, botReply, state, botName, model);
        if (text) {
          const updates = EmotionExpert.parse(text);
          updates.source = 'llm_analysis';
          this.#consecutiveFailures = 0;
          this.#trippedAt = 0;
          this.#tripped = false;
          return EmotionExpert.#ensureCompleteness(updates, state);
        }
        this.#recordFailure();
      } else {
        this.#consecutiveFailures += 1;
      }
    } catch (error) {
      this.#onWarn('emotion analysis failed; using keyword fallback', error);
      this.#recordFailure();
    }
    const fallback = EmotionExpert.#keywordFallback(userMsg, botReply);
    fallback.source = 'smart_fallback';
    return EmotionExpert.#ensureCompleteness(fallback, state);
  }

  #maybeHalfOpen(): void {
    if (this.#tripped && this.#now() - this.#trippedAt >= LLM_CIRCUIT_COOLDOWN_MS) {
      this.#llmAvailable = true;
      this.#tripped = false;
      this.#trippedAt = 0;
      this.#onWarn('emotion analysis circuit cooled down; probing');
    }
  }

  async #callLlmWithRetry(userMsg: string, botReply: string, state: EmotionalState, botName: string, model?: string): Promise<string | null> {
    const prompt = buildExpertPrompt(userMsg, botReply, state, botName || 'AI');
    for (let attempt = 0; attempt < this.#retries; attempt += 1) {
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          this.#chat(prompt, model),
          new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), this.#timeoutMs); }),
        ]).finally(() => clearTimeout(timer));
        if (result && result.trim().length > 10) return result.trim();
      } catch (error) {
        this.#onWarn(`emotion analysis attempt ${attempt + 1}/${this.#retries} failed`, error);
      }
      if (attempt < this.#retries - 1) await this.#sleep(this.#retryDelayMs * (attempt + 1));
    }
    return null;
  }

  #recordFailure(): void {
    this.#consecutiveFailures += 1;
    if (this.#consecutiveFailures >= LLM_MAX_CONSECUTIVE_FAILURES) {
      this.#llmAvailable = false;
      this.#tripped = true;
      this.#trippedAt = this.#now();
      this.#onWarn('emotion analysis circuit open after consecutive failures; keyword fallback active');
    }
  }

  /** Parses the expert JSON; deltas are clamped to the per-dimension limits. */
  static parse(analysisText: string): EmotionUpdates {
    const cleaned = EmotionExpert.#cleanJson(analysisText);
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('no JSON object in emotion analysis output');
    const data = JSON.parse(EmotionExpert.#fixJsonErrors(match[0])) as Record<string, unknown>;
    const raw = data.emotion_updates;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('emotion_updates missing');
    const updates = raw as Record<string, unknown>;
    const out = {} as EmotionUpdates;
    for (const field of ['favor', 'intimacy', ...EMOTION_FIELDS] as const) {
      const raw = updates[field];
      const limit = field === 'favor' || field === 'intimacy' ? FAVOR_DELTA_LIMIT : EMOTION_DELTA_LIMIT;
      out[field] = typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(Math.max(-limit, Math.min(limit, raw))) : 0;
    }
    out.relationshipText = String(data.relationship ?? '正常关系').trim().slice(0, RELATIONSHIP_TEXT_MAX);
    out.attitudeText = String(data.attitude ?? '友好交流').trim().slice(0, ATTITUDE_TEXT_MAX);
    out.source = 'unknown';
    return out;
  }

  static #cleanJson(text: string): string {
    return text.replace(/```(?:json)?\s*/g, '').replace(/\s*```\s*/g, '').trim();
  }

  /** Lenient fix-ups: unquoted keys, single quotes, trailing commas, missing brace. */
  static #fixJsonErrors(input: string): string {
    let text = input.replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3').replace(/'/g, '"');
    text = text.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
    const opens = (text.match(/\{/g) ?? []).length;
    const closes = (text.match(/\}/g) ?? []).length;
    if (opens > closes) text += '}'.repeat(opens - closes);
    return text;
  }

  /** Keyword-only scoring used when no LLM analysis is available. */
  static #keywordFallback(userMsg: string, botReply: string): EmotionUpdates {
    const user = (userMsg ?? '').toLowerCase();
    const reply = (botReply ?? '').toLowerCase();
    const positive = ['好', '开心', '高兴', '谢谢', '感谢', '喜欢', '爱', '不错', '棒', '可爱', '漂亮', '美丽', '相信'];
    const negative = ['讨厌', '生气', '愤怒', '烦', '恨', '滚', '傻', '笨', '蠢', '垃圾', '不愿意'];
    const intimate = ['想你', '想念', '关心', '担心', '在乎', '重要', '宝贝', '亲爱的', '搞好关系'];

    let pos = 0;
    let neg = 0;
    let intimateWeight = 0;
    for (const word of positive) { if (user.includes(word)) pos += 3; if (reply.includes(word)) pos += 1; }
    for (const word of negative) { if (user.includes(word)) neg += 3; if (reply.includes(word)) neg += 1; }
    for (const word of intimate) { if (user.includes(word)) intimateWeight += 2; if (reply.includes(word)) intimateWeight += 1; }

    const empty: EmotionUpdates = {
      favor: 0, intimacy: 0, joy: 0, trust: 0, fear: 0, surprise: 0,
      sadness: 0, disgust: 0, anger: 0, anticipation: 0,
      relationshipText: '', attitudeText: '', source: 'smart_fallback',
    };
    if (neg > pos && neg > 0) {
      return { ...empty, favor: -Math.min(3, neg), intimacy: -1, sadness: 2, anger: 1, disgust: 1 };
    }
    if (pos > neg && pos > 0) {
      return { ...empty, favor: Math.min(3, pos), intimacy: intimateWeight > 0 ? 2 : 1, joy: 2, trust: 1, anticipation: 1 };
    }
    if (intimateWeight > 0) return { ...empty, favor: 1, intimacy: 3, joy: 2, trust: 2, anticipation: 1 };
    return { ...empty, anticipation: 1 };
  }

  /** Fills every dimension so callers never branch on missing keys. */
  static #ensureCompleteness(updates: EmotionUpdates, state: EmotionalState): EmotionUpdates {
    const out = { ...updates };
    for (const field of ['favor', 'intimacy', ...EMOTION_FIELDS] as const) {
      if (typeof out[field] !== 'number' || !Number.isFinite(out[field])) out[field] = 0;
    }
    if (!out.relationshipText) out.relationshipText = state.descriptions.relationship;
    if (!out.attitudeText) out.attitudeText = state.descriptions.attitude;
    if (!out.source) out.source = 'unknown';
    return out;
  }
}
