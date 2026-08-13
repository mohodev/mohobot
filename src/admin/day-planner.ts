import type { AIProvider } from '../ai/types.js';
import type { WorldState } from './world.js';

export interface DayPlanItem {
  at: string;
  activity: string;
  location: string;
  reason: string;
  energyCost: number;
}

export interface DayPlan { date: string; items: DayPlanItem[]; source: 'model' | 'rules'; }

export interface DayPlanner {
  plan(input: { date: string; character: string; world: WorldState }): Promise<DayPlan>;
}

const DEFAULT_ITEMS: DayPlanItem[] = [
  { at: '08:00', activity: '醒来并整理思绪', location: 'online', reason: '开始一天', energyCost: 0.08 },
  { at: '10:00', activity: '处理重要事项', location: 'online', reason: '保持秩序感', energyCost: 0.18 },
  { at: '13:00', activity: '吃饭和浏览消息', location: 'online', reason: '补充能量并观察社交氛围', energyCost: 0.12 },
  { at: '18:00', activity: '参与轻松聊天', location: 'online', reason: '在有兴趣的话题上出现', energyCost: 0.15 },
  { at: '23:00', activity: '回顾今天并休息', location: 'offline', reason: '降低压力', energyCost: -0.25 },
];

export class RuleDayPlanner implements DayPlanner {
  async plan(input: { date: string; character: string; world: WorldState }): Promise<DayPlan> {
    const items: DayPlanItem[] = DEFAULT_ITEMS.map((item): DayPlanItem => ({ ...item }));
    if ((input.world.mood.stress ?? 0) > 0.7) items[3] = { ...items[3]!, activity: '安静独处', reason: '压力较高，减少社交' };
    return { date: input.date, items, source: 'rules' };
  }
}

export class ModelDayPlanner implements DayPlanner {
  readonly #provider: AIProvider;
  readonly #fallback: DayPlanner;
  constructor(provider: AIProvider, fallback = new RuleDayPlanner()) { this.#provider = provider; this.#fallback = fallback; }

  async plan(input: { date: string; character: string; world: WorldState }): Promise<DayPlan> {
    try {
      const response = await this.#provider.chat([
        { role: 'system', content: '你是一个世界模拟器。只输出 JSON：{"items":[{"at":"HH:mm","activity":"...","location":"...","reason":"...","energyCost":0.1}]}。计划应有日常、休息、有限社交，不要让角色全天在线。' },
        { role: 'user', content: JSON.stringify({ date: input.date, character: input.character, world: input.world }) },
      ], { temperature: 0.7, maxTokens: 1200, timeoutMs: 15_000 });
      const parsed = JSON.parse(response.content) as { items?: DayPlanItem[] };
      if (!Array.isArray(parsed.items) || parsed.items.length < 2) throw new Error('model returned an invalid day plan');
      return { date: input.date, items: parsed.items.slice(0, 24), source: 'model' };
    } catch {
      return this.#fallback.plan(input);
    }
  }
}
