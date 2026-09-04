/**
 * emotion - per-user emotional state driving tone + relationship evolution.
 *
 * Ported from upstream carefreesongs712/mohobot `mohobot/emotion/`
 * (astrbot-plugin-emotionai_pro lineage), adapted to the plugin surface:
 *
 *  - pre-LLM  (onBeforeAI): injects the emotional-state / tone block
 *  - post-LLM (onAfterAI):  background second-LLM analysis (keyword fallback
 *    when no provider or after repeated failures)
 *  - relationship stages with hysteresis, long-term interaction memory
 *
 * Privacy (IMMERSION.md): raw scores are never chat-queryable. Admin commands
 * (`isBotManager`) receive a deliberately coarse summary + management actions.
 */

import type { Plugin, PluginContext } from '../../src/plugins/types.js';
import type { AIProvider } from '../../src/ai/types.js';
import type { MohoMessage } from '../../src/core/types.js';
import { createProvider } from '../../src/ai/index.js';
import { decodeReplyPlan, planText } from '../../src/pipeline/reply-plan.js';
import {
  type EmotionalState, deserializeState, serializeState, defaultState,
  MIN_FAVOR, MAX_FAVOR, MIN_INTIMACY, MAX_INTIMACY, clamp, applyEmotion,
} from './models.js';
import { buildInjectionBlock } from './prompts.js';
import { EmotionExpert, type ExpertUpdates } from './expert.js';
import { SmartUpdateManager } from './smart.js';
import { MemorySystem } from './memory.js';
import { applyTransitionBenefits, getStageAdvice, refreshStage } from './relationship.js';

const STATES_KEY = 'states';
const MEMORY_KEY = 'memory';

interface EmotionConfig {
  enabled: boolean;
  smartUpdate: boolean;
  forceUpdateInterval: number;
  significanceThreshold: number;
  timeoutMs: number;
}

let ctx: PluginContext | undefined;
let provider: AIProvider | undefined;
let states = new Map<string, EmotionalState>();
const memory = new MemorySystem();
const smart = new SmartUpdateManager();
let expert: EmotionExpert | undefined;
let writeQueue: Promise<void> = Promise.resolve();
const turnQueues = new Map<string, Promise<void>>();

function cfg(): EmotionConfig {
  const c = ctx?.config ?? {};
  return {
    enabled: c['enabled'] !== false,
    smartUpdate: c['smartUpdate'] !== false,
    forceUpdateInterval: typeof c['forceUpdateInterval'] === 'number' ? c['forceUpdateInterval'] : 6,
    significanceThreshold: typeof c['significanceThreshold'] === 'number' ? c['significanceThreshold'] : 3,
    timeoutMs: typeof c['timeoutMs'] === 'number' ? c['timeoutMs'] : 15000,
  };
}

function getProvider(): AIProvider | undefined {
  if (!ctx) return undefined;
  if (!provider) {
    try {
      provider = createProvider(ctx.botConfig.ai, { logger: ctx.logger, botId: ctx.botConfig.id });
    } catch {
      provider = undefined;
    }
  }
  return provider;
}

function expertLlmCall(prompt: string): Promise<string | null> {
  const p = getProvider();
  if (!p || p.name === 'mock') return Promise.resolve(null); // offline → keyword fallback
  return p.chat(
    [
      { role: 'system', content: '你是情感分析专家。只输出要求的 JSON，不要任何解释。' },
      { role: 'user', content: prompt },
    ],
    { task: 'reflection', temperature: 0.3, timeoutMs: cfg().timeoutMs, stream: false },
  ).then((r) => r.content).catch(() => null);
}

function getOrCreate(userId: string): EmotionalState {
  let state = states.get(userId);
  if (!state) {
    state = defaultState();
    states.set(userId, state);
  }
  return state;
}

function markDirty(): void {
  const snapshot = { states: serializeAll(), memory: memory.serialize() };
  writeQueue = writeQueue.then(async () => {
    if (!ctx) return;
    await ctx.storage.save(STATES_KEY, snapshot.states).catch(() => {});
    await ctx.storage.save(MEMORY_KEY, snapshot.memory).catch(() => {});
  });
}

function serializeAll(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [userId, state] of states) out[userId] = serializeState(state);
  return out;
}

function isAdmin(message: MohoMessage): boolean {
  return message.author.isBotManager === true;
}

function parseTarget(arg: string | undefined): string | undefined {
  if (!arg) return undefined;
  const mention = arg.match(/^<@!?(\d+)>$/);
  if (mention) return mention[1];
  if (/^\d+$/.test(arg)) return arg;
  return undefined;
}

function isErrorPlaceholder(text: string): boolean {
  const head = (text ?? '').slice(0, 30);
  return head.startsWith('[') && /(失败|未返回|错误)/.test(head);
}

function calculateSignificance(updates: ExpertUpdates): number {
  const numeric = numericOnly(updates);
  const total = Object.values(numeric).reduce((n, value) => n + Math.abs(value), 0);
  if (total >= 8) return 8;
  if (total >= 5) return 5;
  if (total >= 2) return 3;
  return 1;
}

/** The numeric deltas only, for stage benefits / emotion application / memory. */
function numericOnly(updates: ExpertUpdates): Record<string, number> {
  return {
    favor: updates.favor, intimacy: updates.intimacy,
    joy: updates.joy, trust: updates.trust, fear: updates.fear, surprise: updates.surprise,
    sadness: updates.sadness, disgust: updates.disgust, anger: updates.anger, anticipation: updates.anticipation,
  };
}

function applyUpdates(state: EmotionalState, updates: ExpertUpdates): void {
  const boosted = applyTransitionBenefits(state, numericOnly(updates));
  applyEmotion(state.emotions, boosted);
  const favorDelta = typeof boosted['favor'] === 'number' ? boosted['favor'] : 0;
  const intimacyDelta = typeof boosted['intimacy'] === 'number' ? boosted['intimacy'] : 0;
  state.favor = clamp(Math.round(state.favor + favorDelta), MIN_FAVOR, MAX_FAVOR);
  state.intimacy = clamp(Math.round(state.intimacy + intimacyDelta), MIN_INTIMACY, MAX_INTIMACY);

  let totalPositive = 0;
  let totalNegative = 0;
  for (const value of Object.values(boosted)) {
    if (typeof value !== 'number') continue;
    if (value > 0) totalPositive += value;
    else totalNegative += -value;
  }
  state.stats.totalCount += 1;
  if (totalPositive >= totalNegative) state.stats.positiveCount += 1;
  else state.stats.negativeCount += 1;
  state.stats.lastInteractionAt = Date.now();

  if (updates.source === 'llm_analysis') {
    if (updates.attitudeText) {
      state.descriptions.attitude = updates.attitudeText.slice(0, 20);
      state.descriptions.lastAttitudeUpdate = Date.now();
    }
    if (updates.relationshipText) {
      state.descriptions.relationship = updates.relationshipText.slice(0, 20);
      state.descriptions.lastRelationshipUpdate = Date.now();
    }
  }
}

async function processTurn(message: MohoMessage, replyText: string): Promise<void> {
  const userId = message.author.id;
  const state = getOrCreate(userId);
  state.forceUpdateCounter += 1;

  const c = cfg();
  const decision = c.smartUpdate
    ? smart.shouldUpdate(state, message.content, replyText, c.forceUpdateInterval)
    : { update: true, reason: '每轮分析(smart_update 关闭)' };

  if (!decision.update) {
    markDirty();
    return;
  }

  const updates = await (expert ?? new EmotionExpert(expertLlmCall)).analyze(message.content, replyText, state, ctx?.botConfig.name ?? 'AI');
  applyUpdates(state, updates);
  const significance = calculateSignificance(updates);
  memory.addInteraction(userId, message.content, replyText, significance, numericOnly(updates), c.significanceThreshold);
  state.forceUpdateCounter = 0;
  state.lastForceUpdate = Date.now();
  refreshStage(state);
  markDirty();
}

function scheduleTurn(message: MohoMessage, replyText: string): void {
  if (!cfg().enabled || !ctx) return;
  if (isErrorPlaceholder(replyText)) return;
  const userId = message.author.id;
  const previous = turnQueues.get(userId) ?? Promise.resolve();
  const next = previous
    .then(() => processTurn(message, replyText))
    .catch((error) => ctx?.logger.warn({ userId, err: String(error) }, 'emotion turn failed'));
  turnQueues.set(userId, next);
  void next.finally(() => {
    if (turnQueues.get(userId) === next) turnQueues.delete(userId);
  });
}

// ── coarse admin view (never raw scores) ──────────────────────────

function coarseView(userId: string): string {
  const state = getOrCreate(userId);
  const stats = memory.userMemoryStats(userId);
  return [
    `关系阶段：${state.relationshipStage}`,
    `态度：${state.descriptions.attitude}`,
    `关系：${state.descriptions.relationship}`,
    `互动：共 ${state.stats.totalCount} 次`,
    `长期记忆：${stats.longTermCount} 条`,
  ].join('\n');
}

function coarseRanking(limit: number): string {
  const entries = [...states.entries()]
    .map(([userId, state]) => ({ userId, state, composite: state.favor * 0.6 + state.intimacy * 0.4 }))
    .sort((a, b) => b.composite - a.composite)
    .slice(0, Math.max(1, Math.min(20, limit)));
  if (entries.length === 0) return '暂无情绪数据。';
  return entries.map((entry, index) => `${index + 1}. <@${entry.userId}> — ${entry.state.relationshipStage}（${entry.state.descriptions.attitude}）`).join('\n');
}

function handleCommand(message: MohoMessage): string | undefined {
  const text = message.content.trim();
  const m = text.match(/^!([\u4e00-\u9fa5A-Za-z-]+)(?:\s+(.*))?$/);
  if (!m || !m[1]) return undefined;
  const name = m[1];
  const rest = (m[2] ?? '').trim();
  const args = rest.length > 0 ? rest.split(/\s+/) : [];

  if (!['情绪', '情绪排行', '设置好感', '设置亲密', '重置情绪', '情绪重置'].includes(name)) return undefined;
  if (!isAdmin(message)) return ''; // silent, never leak privilege state

  if (name === '情绪') {
    const target = parseTarget(args[0]);
    if (!target) return '用法：!情绪 <@用户|ID>';
    return coarseView(target);
  }
  if (name === '情绪排行') {
    const limit = args[0] && /^\d+$/.test(args[0]) ? Number(args[0]) : 10;
    return coarseRanking(limit);
  }
  if (name === '设置好感' || name === '设置亲密') {
    const target = parseTarget(args[0]);
    const value = args[1] && /^-?\d+$/.test(args[1]) ? Number(args[1]) : undefined;
    if (!target || value === undefined) return `用法：!${name} <@用户|ID> <数值>`;
    const state = getOrCreate(target);
    if (name === '设置好感') state.favor = clamp(Math.round(value), MIN_FAVOR, MAX_FAVOR);
    else state.intimacy = clamp(Math.round(value), MIN_INTIMACY, MAX_INTIMACY);
    refreshStage(state);
    markDirty();
    return `已更新 <@${target}>（阶段：${state.relationshipStage}）`;
  }
  if (name === '重置情绪') {
    const target = parseTarget(args[0]);
    if (!target) return '用法：!重置情绪 <@用户|ID>';
    states.set(target, defaultState());
    memory.clearUser(target);
    markDirty();
    return `已重置 <@${target}> 的情绪状态。`;
  }
  if (name === '情绪重置') {
    states = new Map();
    memory.clearAll();
    markDirty();
    return '已清空本 bot 的全部情绪数据。';
  }
  return undefined;
}

const plugin: Plugin = {
  name: 'emotion',

  async onLoad(context) {
    ctx = context;
    provider = undefined;
    expert = new EmotionExpert(expertLlmCall);

    // Hydrate per-bot state + memory from scoped storage.
    const storedStates = await context.storage.get<Record<string, unknown>>(STATES_KEY).catch(() => undefined);
    const storedMemory = await context.storage.get<Record<string, unknown>>(MEMORY_KEY).catch(() => undefined);
    states = new Map();
    for (const [userId, raw] of Object.entries(storedStates ?? {})) states.set(userId, deserializeState(raw));
    memory.load(storedMemory ?? {});

    context.logger.info({ users: states.size }, 'emotion plugin ready');
  },

  onUnload() {
    ctx = undefined;
    provider = undefined;
    expert = undefined;
  },

  onMessage(message) {
    if (!ctx || message.author.bot) return undefined;
    const reply = handleCommand(message);
    if (reply !== undefined) return { stop: true, reply: reply || undefined };
    return undefined;
  },

  onBeforeAI(input) {
    if (!ctx || !cfg().enabled) return;
    const userId = input.message.author.id;
    const state = getOrCreate(userId);
    const relationshipContext = memory.buildRelationshipContext(userId);
    const block = buildInjectionBlock(state, ctx.botConfig.name, relationshipContext);
    input.messages.splice(1, 0, { role: 'system', content: block });
  },

  onAfterAI(input) {
    if (!ctx) return input.reply;
    const text = planText(decodeReplyPlan(input.reply));
    scheduleTurn(input.message, text);
    return input.reply;
  },
};

export { getStageAdvice };
export default plugin;
