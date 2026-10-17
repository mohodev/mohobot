/**
 * Emotion persistence + update gating + orchestration.
 *
 * Ported from carefreesongs712/mohobot `mohobot/emotion/{store,memory,smart,
 * manager}.py` (astrbot-plugin-emotionai_pro). One directory per bot holds the
 * user states and the significant-interaction timeline:
 *
 *   <rootDir>/data/emotion/<botId>/user_states.json
 *   <rootDir>/data/emotion/<botId>/memory.json
 *
 * Writes are debounced through a dirty set and flushed by the task supervisor,
 * so a chatty room costs one file write per flush interval, not per turn.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type { Logger } from '../core/logger.js';
import {
  ATTITUDE_TEXT_MAX,
  clamp,
  EmotionalState,
  EMOTION_FIELDS,
  type InteractionRecord,
  MAX_FAVOR,
  MAX_INTIMACY,
  MIN_FAVOR,
  MIN_INTIMACY,
  STAGE_NAMES,
} from './models.js';
import { StageManager, type StageInfo } from './relationship.js';
import { buildInjectionBlock } from './attitude.js';
import { EmotionExpert, type EmotionUpdates } from './expert.js';

const USER_STATES_FILE = 'user_states.json';
const MEMORY_FILE = 'memory.json';
const MAX_PER_USER = 50;
const MAX_IMPORTANT_EVENTS = 50;
const RECORD_TEXT_LIMIT = 500;

/** Turn-level significance: totals ≥8/5/2 map to 8/5/3, else 1. */
export function significanceOf(updates: Record<string, number>): number {
  let total = 0;
  for (const [key, value] of Object.entries(updates)) {
    if (key === 'source' || typeof value !== 'number' || !Number.isFinite(value)) continue;
    total += Math.abs(value);
  }
  if (total >= 8) return 8;
  if (total >= 5) return 5;
  if (total >= 2) return 3;
  return 1;
}

/**
 * Decides whether a turn is worth an LLM analysis at all: emotional keywords,
 * a stale description, a long gap, a forced interval, or a returning user.
 * Cheap and deterministic — no model call, no randomness.
 */
export function shouldUpdate(state: EmotionalState, userMessage: string, forceInterval: number, keywordThreshold = 3, now: number = Date.now()): { update: boolean; reason: string } {
  const reasons: string[] = [];

  // Never-analysed users always get one analysis so the relationship exists.
  if (state.lastForceUpdate === 0) reasons.push('首次互动');
  else {
    const values = EMOTION_FIELDS.map((field) => state.emotions[field]);
    if (values.length > 0 && Math.max(...values) - Math.min(...values) >= 8) reasons.push('情感强度重大变化');
  }

  const keyword = analyzeKeywords(userMessage, keywordThreshold);
  if (keyword.match) reasons.push(keyword.reason);

  if (state.lastForceUpdate !== 0) {
    if (now - state.descriptions.lastAttitudeUpdate > 24 * 60 * 60_000) reasons.push('长时间未更新');
    else if (now - state.lastForceUpdate > 60 * 60_000) reasons.push('长时间未更新');
  }

  if (state.shouldForceUpdate(forceInterval, now)) reasons.push('强制更新机制');
  if (state.stats.totalCount > 0 && state.stats.daysSinceLast(now) > 7) reasons.push('久别重逢');

  return reasons.length > 0 ? { update: true, reason: reasons.join(' | ') } : { update: false, reason: '无明显情感变化' };
}

const EMOTIONAL_KEYWORDS: Record<string, string[]> = {
  positive: ['喜欢', '爱', '开心', '高兴', '谢谢', '感谢', '感动', '温暖', '棒', '不错', '可爱', '漂亮', '美丽'],
  negative: ['讨厌', '恨', '生气', '愤怒', '伤心', '难过', '失望', '烦', '滚', '傻', '笨', '蠢', '垃圾', '不愿意'],
  intimate: ['想你', '想念', '关心', '担心', '在乎', '重要', '宝贝', '亲爱的', '搞好关系', '拥抱', '吻'],
  conflict: ['吵架', '争执', '不满', '抱怨', '批评', '指责', '反对', '不同意'],
};
const KEYWORD_WEIGHT: Record<string, number> = { positive: 2, negative: 3, intimate: 2, conflict: 3 };
const STRONG_PATTERNS = [/非常(?:好|喜欢|爱|开心)/, /特别(?:好|喜欢|爱|开心)/, /太(?:好|喜欢|爱|开心)/, /真的(?:好|喜欢|爱|开心)/, /非常(?:讨厌|恨|生气|烦)/, /特别(?:讨厌|恨|生气|烦)/];

function analyzeKeywords(userMessage: string, threshold: number): { match: boolean; reason: string } {
  const text = userMessage ?? '';
  const lower = text.toLowerCase();
  const thresholdValue = Math.max(1, Math.trunc(threshold));
  const detected = new Set<string>();
  let intensity = 0;
  for (const [category, words] of Object.entries(EMOTIONAL_KEYWORDS)) {
    for (const word of words) {
      if (lower.includes(word)) {
        detected.add(category);
        intensity += KEYWORD_WEIGHT[category] ?? 1;
      }
    }
  }
  for (const pattern of STRONG_PATTERNS) if (pattern.test(text)) intensity += 2;
  if (/[:：][)）]|[😊😄😍🥰🤗]/u.test(text)) intensity += 1;
  if (/[:：][(（]|[😠😡😢😭😤]/u.test(text)) intensity += 1;
  if (text.includes('?') || text.includes('？')) intensity += 0.5;
  if (text.includes('!') || text.includes('！')) intensity += 1;

  if (intensity < thresholdValue) return { match: false, reason: '' };
  if (detected.has('negative') && detected.has('conflict')) return { match: true, reason: '用户表达强烈负面情感和冲突' };
  if (detected.has('negative')) return { match: true, reason: '用户表达负面情感' };
  if (detected.has('positive') && detected.has('intimate')) return { match: true, reason: '用户表达积极亲密情感' };
  if (detected.has('positive')) return { match: true, reason: '用户表达积极情感' };
  if (detected.has('intimate')) return { match: true, reason: '用户表达亲密情感' };
  return { match: true, reason: '对话包含情感关键词' };
}

export interface EmotionManagerOptions {
  rootDir: string;
  botId: string;
  logger: Logger;
  /** Second-pass model call; analysis is a small JSON task. */
  chat: (prompt: string, model?: string) => Promise<string | null>;
  config: EmotionRuntimeConfig;
  /** Component label used in logs; defaults to 'emotion'. */
  component?: string;
  now?: () => number;
}

export interface EmotionRuntimeConfig {
  enabled: boolean;
  /** Rounds to skip between analyses when nothing forces one. */
  analysisRoundCooldown: number;
  minIntervalMs: number;
  forceUpdateInterval: number;
  keywordThreshold: number;
  /** Significant-interaction write threshold. */
  significanceThreshold: number;
  smartUpdate: boolean;
  analysisTimeoutMs: number;
  maxConcurrent: number;
  favorMin: number;
  favorMax: number;
  intimacyMin: number;
  intimacyMax: number;
}

export const DEFAULT_EMOTION_CONFIG: EmotionRuntimeConfig = {
  enabled: true,
  analysisRoundCooldown: 1,
  minIntervalMs: 5_000,
  forceUpdateInterval: 8,
  keywordThreshold: 3,
  significanceThreshold: 3,
  smartUpdate: true,
  analysisTimeoutMs: 90_000,
  maxConcurrent: 2,
  favorMin: MIN_FAVOR,
  favorMax: MAX_FAVOR,
  intimacyMin: MIN_INTIMACY,
  intimacyMax: MAX_INTIMACY,
};

export interface EmotionRankEntry {
  userKey: string;
  averageScore: number;
  favor: number;
  intimacy: number;
  stage: string;
  state: EmotionalState;
}

export class EmotionManager {
  readonly #rootDir: string;
  readonly #botId: string;
  readonly #logger: Logger;
  readonly #config: EmotionRuntimeConfig;
  readonly #expert: EmotionExpert;
  readonly #now: () => number;

  #states = new Map<string, EmotionalState>();
  #memory = new Map<string, InteractionRecord[]>();
  #important: Array<{ significance: number; timestamp: number; botId: string; userKey: string; preview: string }> = [];
  #dirty = false;
  #loaded = false;
  #inflight = new Set<Promise<void>>();

  constructor(options: EmotionManagerOptions) {
    this.#rootDir = options.rootDir;
    this.#botId = options.botId;
    this.#logger = options.logger.child({ component: options.component ?? `emotion:${options.botId}` });
    this.#config = { ...DEFAULT_EMOTION_CONFIG, ...options.config };
    this.#now = options.now ?? Date.now;
    this.#expert = new EmotionExpert({
      chat: options.chat,
      timeoutMs: this.#config.analysisTimeoutMs,
      now: this.#now,
      onWarn: (message, detail) => this.#logger.warn({ err: detail }, message),
    });
  }

  get enabled(): boolean { return this.#config.enabled; }

  /** Per-bot state directory: <rootDir>/data/emotion/<botId>. */
  get dir(): string { return path.join(this.#rootDir, 'data', 'emotion', this.#botId); }

  async #ensureLoaded(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    const states = await readJson<Record<string, unknown>>(path.join(this.dir, USER_STATES_FILE), {});
    for (const [userKey, data] of Object.entries(states)) {
      this.#states.set(userKey, EmotionalState.fromDict(data as Record<string, unknown>));
    }
    const memory = await readJson<Record<string, unknown>>(path.join(this.dir, MEMORY_FILE), {});
    for (const [userKey, rows] of Object.entries(memory)) {
      if (!Array.isArray(rows)) continue;
      this.#memory.set(userKey, rows.slice(-MAX_PER_USER).map((row) => normalizeRecord(row)));
    }
    this.#logger.debug({ users: this.#states.size }, 'emotion state loaded');
  }

  /** Fire-and-forget background analysis; failures only skip the update. */
  scheduleTurn(userKey: string, userText: string, aiReply: string): void {
    if (!this.#config.enabled) return;
    if (!userKey || !aiReply) return;
    const preview = aiReply.slice(0, 30);
    if (preview.startsWith('[') && (preview.includes('失败') || preview.includes('错误') || preview.includes('未返回'))) return;
    const promise = this.processTurn(userKey, userText, aiReply).catch((error) => {
      this.#logger.warn({ err: error instanceof Error ? error.message : String(error), user: userKey }, 'emotion turn processing failed');
    });
    this.#inflight.add(promise);
    void promise.finally(() => this.#inflight.delete(promise));
  }

  /** One turn of relationship updates. Safe to call directly in tests. */
  async processTurn(userKey: string, userText: string, aiReply: string): Promise<void> {
    if (!this.#config.enabled || !userKey) return;
    await this.#ensureLoaded();
    const state = this.#getOrCreate(userKey);
    // Only turns that actually get an analysis count as interactions; the
    // cooldown gate below returns before any recording happens.
    state.forceUpdateCounter += 1;

    const cooldown = this.#cooldownGate(state);
    if (!cooldown.proceed) {
      this.#dirty = true;
      return;
    }

    let decision = { update: true, reason: cooldown.reason };
    if (this.#config.smartUpdate) {
      decision = shouldUpdate(state, userText, this.#config.forceUpdateInterval, this.#config.keywordThreshold, this.#now());
    }
    if (!decision.update) {
      this.#dirty = true;
      return;
    }

    this.#logger.debug({ user: userKey, reason: decision.reason }, 'emotion analysis triggered');
    const updates = await this.#expert.analyze(userText, aiReply, state, this.#botId);
    EmotionManager.#applyUpdates(this.#config, state, updates, this.#now());

    const significance = significanceOf(updates as unknown as Record<string, number>);
    if (significance >= this.#config.significanceThreshold) this.#addRecord(userKey, userText, aiReply, significance, updates);

    state.resetForceUpdateCounter(this.#now());
    StageManager.getStageInfo(state);
    this.#dirty = true;
  }

  /** Analysis frequency gate: per-round counter plus a wall-clock floor. */
  #cooldownGate(state: EmotionalState): { proceed: boolean; reason: string } {
    if (state.lastForceUpdate === 0) return { proceed: true, reason: 'first analysis' };
    if (state.forceUpdateCounter < Math.max(0, this.#config.analysisRoundCooldown)) {
      return { proceed: false, reason: 'analysis round cooldown' };
    }
    if (this.#now() - state.lastForceUpdate < Math.max(0, this.#config.minIntervalMs)) {
      return { proceed: false, reason: 'analysis interval floor' };
    }
    return { proceed: true, reason: 'analysis due' };
  }

  #addRecord(userKey: string, userText: string, aiReply: string, significance: number, updates: EmotionUpdates): void {
    const changes: Record<string, number> = {};
    for (const [key, value] of Object.entries(updates)) {
      if (key === 'source' || typeof value !== 'number' || value === 0) continue;
      changes[key] = value;
    }
    const records = this.#memory.get(userKey) ?? [];
    records.push({
      userMsg: userText.slice(0, RECORD_TEXT_LIMIT),
      aiResponse: aiReply.slice(0, RECORD_TEXT_LIMIT),
      timestamp: this.#now(),
      significance,
      emotionalChanges: changes,
    });
    if (records.length > MAX_PER_USER) records.splice(0, records.length - MAX_PER_USER);
    this.#memory.set(userKey, records);

    this.#important.push({ significance, timestamp: this.#now(), botId: this.#botId, userKey, preview: userText.slice(0, 100) });
    if (this.#important.length > MAX_IMPORTANT_EVENTS) {
      this.#important.sort((a, b) => b.significance - a.significance || b.timestamp - a.timestamp);
      this.#important.length = MAX_IMPORTANT_EVENTS;
    }
  }

  static #applyUpdates(config: EmotionRuntimeConfig, state: EmotionalState, updates: EmotionUpdates, now: number): void {
    const boosted = StageManager.applyTransitionBenefits(state, { ...updates } as unknown as Record<string, number>);
    state.emotions.applyUpdate(boosted);

    for (const [field, delta] of [['favor', updates.favor], ['intimacy', updates.intimacy]] as const) {
      if (typeof delta !== 'number' || !Number.isFinite(delta)) continue;
      const low = field === 'favor' ? config.favorMin : config.intimacyMin;
      const high = field === 'favor' ? config.favorMax : config.intimacyMax;
      state[field] = clamp(state[field] + Math.trunc(delta), low, high);
    }

    const numeric = [updates.favor, updates.intimacy, ...EMOTION_FIELDS.map((field) => updates[field])]
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    const positive = numeric.reduce((sum, value) => sum + (value > 0 ? value : 0), 0);
    const negative = numeric.reduce((sum, value) => sum + (value < 0 ? -value : 0), 0);
    state.stats.record(positive >= negative, now);

    // Only a real analysis may rewrite the prompt-visible descriptions.
    if (updates.source === 'llm_analysis') {
      const attitude = updates.attitudeText.trim().slice(0, ATTITUDE_TEXT_MAX);
      if (attitude) state.descriptions.updateAttitude(attitude, now);
      if (updates.relationshipText.trim()) state.descriptions.updateRelationship(updates.relationshipText, now);
    }
  }

  /** Pre-LLM system block. Returns "" when disabled or nothing is known yet. */
  async buildContextBlock(userKey: string): Promise<string> {
    if (!this.#config.enabled || !userKey) return '';
    await this.#ensureLoaded();
    const state = this.#states.get(userKey);
    if (!state) return '';
    return buildInjectionBlock(state, this.#botId, buildRelationshipContext(this.#memory.get(userKey) ?? [], this.#important, this.#botId, userKey));
  }

  /** Stage snapshot for the stage command; refreshes cached stage fields. */
  async getStageInfo(userKey: string): Promise<{ state: EmotionalState; info: StageInfo }> {
    await this.#ensureLoaded();
    const state = this.#getOrCreate(userKey);
    return { state, info: StageManager.getStageInfo(state) };
  }

  async getState(userKey: string): Promise<EmotionalState> {
    await this.#ensureLoaded();
    return this.#getOrCreate(userKey);
  }

  /** Read-only snapshot for the admin commands (refreshes the cached stage). */
  async getSnapshot(userKey: string): Promise<{
    userKey: string; favor: number; intimacy: number; stageName: string; stageDescription: string;
    compositeScore: number; progressToNext: number; nextStageName: string; nextStageThreshold: number | null;
    dominantMood: string; attitude: string; relationship: string;
    interactions: { total: number; positive: number; negative: number; positiveRatio: number };
    advice: string;
  }> {
    const { state, info } = await this.getStageInfo(userKey);
    return {
      userKey: state.userKey,
      favor: state.favor,
      intimacy: state.intimacy,
      stageName: info.stageName,
      stageDescription: info.description,
      compositeScore: info.compositeScore,
      progressToNext: info.progressToNext,
      nextStageName: info.nextStageName,
      nextStageThreshold: info.nextStageThreshold,
      dominantMood: state.emotions.getDominant(),
      attitude: state.descriptions.attitude,
      relationship: state.descriptions.relationship,
      interactions: {
        total: state.stats.totalCount,
        positive: state.stats.positiveCount,
        negative: state.stats.negativeCount,
        positiveRatio: state.stats.positiveRatio,
      },
      advice: StageManager.getStageAdvice(state),
    };
  }

  async ranking(limit = 10, direction: 'top' | 'bottom' = 'top'): Promise<EmotionRankEntry[]> {
    await this.#ensureLoaded();
    const entries: EmotionRankEntry[] = [...this.#states.values()].map((state) => {
      let average = state.favor * 0.6 + state.intimacy * 0.4;
      if (state.stats.totalCount > 0) average *= 1 + Math.min(1, state.stats.totalCount / 100) * 0.1;
      return { userKey: state.userKey, averageScore: average, favor: state.favor, intimacy: state.intimacy, stage: state.relationshipStage, state };
    });
    entries.sort((a, b) => direction === 'top' ? b.averageScore - a.averageScore : a.averageScore - b.averageScore);
    return entries.slice(0, Math.max(1, Math.min(20, limit)));
  }

  setFavor(userKey: string, value: number): EmotionalState {
    const state = this.#getOrCreate(userKey);
    state.favor = clamp(value, this.#config.favorMin, this.#config.favorMax);
    StageManager.getStageInfo(state);
    this.#dirty = true;
    return state;
  }

  setIntimacy(userKey: string, value: number): EmotionalState {
    const state = this.#getOrCreate(userKey);
    state.intimacy = clamp(value, this.#config.intimacyMin, this.#config.intimacyMax);
    StageManager.getStageInfo(state);
    this.#dirty = true;
    return state;
  }

  setAttitude(userKey: string, text: string): boolean {
    const state = this.#getOrCreate(userKey);
    const ok = state.descriptions.updateAttitude(text.slice(0, ATTITUDE_TEXT_MAX));
    if (ok) this.#dirty = true;
    return ok;
  }

  resetUser(userKey: string): EmotionalState {
    const state = new EmotionalState(userKey);
    StageManager.getStageInfo(state);
    this.#states.set(userKey, state);
    this.#memory.delete(userKey);
    this.#important = this.#important.filter((event) => event.userKey !== userKey);
    this.#dirty = true;
    return state;
  }

  clearBot(): void {
    this.#states.clear();
    this.#memory.clear();
    this.#important = [];
    this.#dirty = true;
  }

  /** Writes dirty state to disk; called by the periodic housekeeping task. */
  async flush(): Promise<void> {
    if (!this.#dirty || !this.#loaded) return;
    this.#dirty = false;
    const statesPayload: Record<string, unknown> = {};
    for (const [userKey, state] of this.#states) statesPayload[userKey] = state.toDict();
    const memoryPayload: Record<string, unknown> = {};
    for (const [userKey, records] of this.#memory) memoryPayload[userKey] = records.map((record) => ({ ...record }));
    try {
      await writeJson(path.join(this.dir, USER_STATES_FILE), statesPayload);
      await writeJson(path.join(this.dir, MEMORY_FILE), memoryPayload);
    } catch (error) {
      this.#dirty = true;
      this.#logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'emotion flush failed');
    }
  }

  /** Resolves once every background analysis started so far has settled. */
  async settle(): Promise<void> {
    await Promise.allSettled([...this.#inflight]);
  }

  circuitStatus(): ReturnType<EmotionExpert['status']> { return this.#expert.status(); }

  #getOrCreate(userKey: string): EmotionalState {
    const existing = this.#states.get(userKey);
    if (existing) return existing;
    const state = new EmotionalState(userKey);
    state.relationshipStage = STAGE_NAMES.INITIAL!;
    this.#states.set(userKey, state);
    return state;
  }
}

/** "长期关系发展轨迹" block injected alongside the emotion state. */
export function buildRelationshipContext(
  records: InteractionRecord[],
  important: Array<{ significance: number; userKey: string }>,
  botId: string,
  userKey: string,
): string {
  if (records.length === 0) return '';
  const importantCount = important.filter((event) => event.userKey === userKey).length;
  const average = records.reduce((sum, record) => sum + record.significance, 0) / records.length;
  const recentSignificant = records.filter((record) => record.significance >= 7).length;
  const lines = ['【长期关系发展轨迹】', `深度互动次数: ${records.length}`, `平均情感深度: ${average.toFixed(1)}/10`];
  if (recentSignificant > 0) lines.push(`近期重要互动: ${recentSignificant}次`);
  if (importantCount > 0) lines.push(`重要时刻: ${importantCount}个`);
  return lines.join('\n');
}

function normalizeRecord(raw: unknown): InteractionRecord {
  const row = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const changes: Record<string, number> = {};
  const rawChanges = row.emotionalChanges;
  if (rawChanges && typeof rawChanges === 'object' && !Array.isArray(rawChanges)) {
    for (const [key, value] of Object.entries(rawChanges as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) changes[key] = Math.trunc(value);
    }
  }
  return {
    userMsg: typeof row.userMsg === 'string' ? row.userMsg.slice(0, RECORD_TEXT_LIMIT) : '',
    aiResponse: typeof row.aiResponse === 'string' ? row.aiResponse.slice(0, RECORD_TEXT_LIMIT) : '',
    timestamp: typeof row.timestamp === 'number' && Number.isFinite(row.timestamp) ? row.timestamp : 0,
    significance: typeof row.significance === 'number' && Number.isFinite(row.significance) ? Math.trunc(row.significance) : 0,
    emotionalChanges: changes,
  };
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as T;
    return fallback;
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, payload: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, file);
}

export const EMOTION_LIMITS = { MAX_FAVOR, MAX_INTIMACY, MIN_FAVOR, MIN_INTIMACY };
