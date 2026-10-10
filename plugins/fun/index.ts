/**
 * Fun plugin: daily divination + the 6/66/666 number meme.
 *
 * Discord-native port of upstream's divination + six66 plugins. Both are pure
 * message hooks: no model call, no new events, no privileged intents.
 *
 * - 占卜: `/占卜`, `占卜` or `今日占卜` (exact match, or `/占卜` prefix) once
 *   per user per day. Deterministic per user per day so nobody can reroll by
 *   reposting; the pipeline stops here (no AI call wasted on a fortune).
 * - 6/66/666: exact match only, guild channels only, 20% roll. A matching
 *   message that loses the roll continues to the AI normally.
 */

import type { Plugin } from '../../src/plugins/types.js';
import type { MohoMessage } from '../../src/core/types.js';

export const DIVINATION_FIELDS = ['财运', '事业', '姻缘', '健康', '出行', '学业', '运气'] as const;

const LUCKY_COLORS = ['薄荷绿', '晴空蓝', '樱花粉', '柠檬黄', '墨黑', '月白', '橘红', '松绿'];
const LUCKY_ITEMS = ['小笼包', '耳机', '吉他拨片', '车票', '雨伞', '笔记本', '薄荷糖', '创可贴'];
const FORTUNES = ['大吉', '中吉', '小吉', '吉', '末吉'] as const;

export const SIX66_REPLIES: Record<string, string> = {
  '6': '6=5+2+0+1+3-1-4\n你是不是在喜欢我呀（偷笑）',
  '66': '66=52+0×13+14\n你是不是在喜欢我呀（偷笑）',
  '666': '666=(52-0!)×13-1+4\n你是不是在喜欢我呀（偷笑）',
};

function hash32(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function dayKey(now = Date.now()): string {
  const date = new Date(now);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Deterministic PRNG so one user gets one fortune per day. */
export function divinationFor(userId: string, now = Date.now()): string {
  let state = hash32(`${userId}:${dayKey(now)}`);
  const next = (mod: number): number => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state % mod;
  };
  const rows = DIVINATION_FIELDS.map((field) => `${field}：${'★'.repeat(1 + next(5))}`);
  const fortune = FORTUNES[next(FORTUNES.length)]!;
  const color = LUCKY_COLORS[next(LUCKY_COLORS.length)]!;
  const item = LUCKY_ITEMS[next(LUCKY_ITEMS.length)]!;
  const number = next(100);
  return ['📿 今日占卜', ...rows, `总评：${fortune}`, `幸运色：${color}｜幸运物：${item}｜幸运数：${number}`].join('\n');
}

/** True for `/占卜`, bare `占卜` and `今日占卜` (exact; `/占卜 ...` prefix). */
export function isDivinationTrigger(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === '占卜' || trimmed === '今日占卜' || trimmed === '/占卜' || trimmed.startsWith('/占卜 ');
}

/** Exact `6` / `66` / `666` only. */
export function six66Reply(text: string): string | undefined {
  return SIX66_REPLIES[text.trim()];
}

const plugin: Plugin = {
  name: 'fun',
  triggers: ['占卜', '今日占卜', '/占卜', '6', '66', '666', /^\/占卜(\s|$)/],

  async onMessage(message: MohoMessage, ctx) {
    if (message.author.bot) return undefined;
    const text = message.content.trim();
    if (!text) return undefined;

    if (isDivinationTrigger(text)) {
      const key = `div:${message.author.id}:${dayKey()}`;
      const seen = await ctx.storage.get<string>(key).catch(() => undefined);
      if (seen) return { stop: true, reply: '今天已经占过啦，明天再来吧～' };
      const reply = divinationFor(message.author.id);
      await ctx.storage.save(key, reply, 36 * 3600).catch(() => {});
      return { stop: true, reply };
    }

    if (!message.channel.dm) {
      const meme = six66Reply(text);
      if (meme !== undefined) {
        const probability = Number(ctx.config['probability'] ?? 20);
        const roll = Number.isFinite(probability) ? Math.max(0, Math.min(100, probability)) : 20;
        if (Math.random() * 100 < roll) return { stop: true, reply: meme };
      }
    }
    return undefined;
  },
};

export default plugin;
