/**
 * Smart update decision — ported from upstream `mohobot/emotion/smart.py`.
 *
 * Decides whether a turn is worth a second LLM emotion-analysis call, using
 * content heuristics, time-since-last-update, force-update cadence and
 * long-absence. Purely local; no network.
 */

import type { EmotionalState } from './models.js';

const MAJOR_CHANGE = 8;

const EMOTIONAL_KEYWORDS: Record<string, string[]> = {
  positive: ['喜欢', '爱', '开心', '高兴', '谢谢', '感谢', '感动', '温暖', '棒', '好', '不错', '可爱', '漂亮', '美丽'],
  negative: ['讨厌', '恨', '生气', '愤怒', '伤心', '难过', '失望', '烦', '滚', '傻', '笨', '蠢', '垃圾', '不愿意'],
  intimate: ['想你', '想念', '关心', '担心', '在乎', '重要', '宝贝', '亲爱的', '搞好关系', '拥抱', '吻'],
  conflict: ['吵架', '争执', '不满', '抱怨', '批评', '指责', '反对', '不同意'],
};

const INTENSITY_PATTERNS: Record<string, RegExp> = {
  strong_positive: /(非常|特别|极其|太|真的)好|喜欢|爱|开心/,
  strong_negative: /(非常|特别|极其|太|真的)讨厌|恨|生气|烦/,
  question: /[？?]/,
  exclamation: /[！!]/,
  emoticon_positive: /[:：][)）]|😊|😄|😍|🥰|🤗/,
  emoticon_negative: /[:：][(（]|😠|😡|😢|😭|😤/,
};

export class SmartUpdateManager {
  shouldUpdate(state: EmotionalState, userMessage: string, aiResponse: string, forceInterval: number): { update: boolean; reason: string } {
    const reasons: string[] = [];

    let max = 0;
    let min = 100;
    for (const value of Object.values(state.emotions)) {
      max = Math.max(max, value);
      min = Math.min(min, value);
    }
    if (max - min >= MAJOR_CHANGE) reasons.push('情感强度重大变化');

    const keyword = this.#analyzeKeywords(userMessage, aiResponse);
    if (keyword.shouldUpdate) reasons.push(keyword.reason);

    if (this.#isStale(state)) reasons.push('长时间未更新');

    if (shouldForceUpdate(state, forceInterval)) reasons.push('强制更新机制');

    if (state.stats.totalCount > 0 && daysSince(state.stats.lastInteractionAt) > 7) reasons.push('久别重逢');

    return { update: reasons.length > 0, reason: reasons.length > 0 ? reasons.join(' | ') : '无明显情感变化' };
  }

  #analyzeKeywords(userMessage: string, aiResponse: string): { shouldUpdate: boolean; reason: string } {
    const userLower = (userMessage ?? '').toLowerCase();
    const replyLower = (aiResponse ?? '').toLowerCase();
    const categoryWeight: Record<string, number> = { positive: 2, negative: 3, intimate: 2, conflict: 3 };

    let intensity = 0;
    const detected = new Set<string>();
    for (const [category, keywords] of Object.entries(EMOTIONAL_KEYWORDS)) {
      for (const kw of keywords) {
        if (userLower.includes(kw)) { detected.add(category); intensity += categoryWeight[category] ?? 1; }
        if (replyLower.includes(kw)) { detected.add(category); intensity += 1; }
      }
    }

    for (const [name, pattern] of Object.entries(INTENSITY_PATTERNS)) {
      if (pattern.test(userMessage ?? '') || pattern.test(aiResponse ?? '')) {
        if (name.includes('strong')) intensity += 2;
        else if (name.includes('emoticon')) intensity += 1;
        else if (name === 'question') intensity += 0.5;
        else if (name === 'exclamation') intensity += 1;
      }
    }

    if (intensity < 2) return { shouldUpdate: false, reason: '' };
    let reason: string;
    if (detected.has('negative') && detected.has('conflict')) reason = '用户表达强烈负面情感和冲突';
    else if (detected.has('negative')) reason = '用户表达负面情感';
    else if (detected.has('positive') && detected.has('intimate')) reason = '用户表达积极亲密情感';
    else if (detected.has('positive')) reason = '用户表达积极情感';
    else if (detected.has('intimate')) reason = '用户表达亲密情感';
    else reason = '对话包含情感关键词';
    return { shouldUpdate: true, reason };
  }

  #isStale(state: EmotionalState): boolean {
    const now = Date.now();
    if (now - state.descriptions.lastAttitudeUpdate > 86_400_000) return true;
    if (now - state.descriptions.lastRelationshipUpdate > 86_400_000) return true;
    return now - state.lastForceUpdate > 3_600_000;
  }
}

function shouldForceUpdate(state: EmotionalState, forceInterval: number): boolean {
  if (state.forceUpdateCounter >= Math.max(1, forceInterval)) return true;
  return Date.now() - state.lastForceUpdate > 3_600_000;
}

function daysSince(timestamp: number): number {
  if (!timestamp) return Number.POSITIVE_INFINITY;
  return (Date.now() - timestamp) / 86_400_000;
}
