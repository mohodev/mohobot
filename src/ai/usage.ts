/**
 * Per-module token accounting.
 *
 * Upstream tracks every LLM call by module (`main_chat`, `summarize`, ...) so
 * operators can see where the quota goes. This is the same idea adapted to our
 * provider stack: a thin decorator records each successful call's usage under
 * its scheduler lane, and `?用量` reads the totals back. Recording never
 * throws - housekeeping must not fail the turn that triggered it.
 */

import type { Logger } from '../core/logger.js';
import type { ChatMessage } from '../core/types.js';
import type { Storage } from '../storage/types.js';
import type { AIProvider, AIResponse, ChatOptions } from './types.js';

/** What providers actually report (opencode-cli extracts step-finish tokens). */
export interface UsageNumbers {
  input?: number;
  output?: number;
  promptTokens?: number;
  completionTokens?: number;
}

export type UsageModule = 'reply' | 'summary' | 'analysis' | 'ab' | 'vision' | 'other';

const MODULE_NAMES: Record<UsageModule, string> = {
  reply: '主回复',
  summary: '上下文总结',
  analysis: '后台分析',
  ab: '人设对比',
  vision: '视觉识别',
  other: '其他',
};

/** Scheduler lane -> accounting bucket. Unknown lanes stay visible, not lost. */
export function moduleForTask(task: ChatOptions['task']): UsageModule {
  switch (task) {
    case 'reply':
    case undefined:
      return 'reply';
    case 'summary':
      return 'summary';
    case 'admin':
    case 'reflection':
      return 'analysis';
    case 'ab':
      return 'ab';
    case 'vision':
      return 'vision';
    default:
      return 'other';
  }
}

export interface UsageTotals {
  calls: number;
  input: number;
  output: number;
}

const KEY_PREFIX = 'usage:';

function dayKey(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export class UsageRecorder {
  readonly #storage: Storage;
  readonly #logger: Logger;
  readonly #now: () => number;

  constructor(deps: { storage: Storage; logger: Logger; now?: () => number }) {
    this.#storage = deps.storage;
    this.#logger = deps.logger.child({ component: 'usage' });
    this.#now = deps.now ?? Date.now;
  }

  async record(botId: string, module: UsageModule, usage: UsageNumbers | undefined): Promise<void> {
    try {
      const input = usage?.input ?? usage?.promptTokens ?? 0;
      const output = usage?.output ?? usage?.completionTokens ?? 0;
      const key = `${KEY_PREFIX}${botId}:${dayKey(new Date(this.#now()))}:${module}`;
      const current = (await this.#storage.get<UsageTotals>(key)) ?? { calls: 0, input: 0, output: 0 };
      await this.#storage.save(key, {
        calls: current.calls + 1,
        input: current.input + input,
        output: current.output + output,
      });
    } catch (error) {
      this.#logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'usage record failed');
    }
  }

  /** Totals per module over the last `days` days (1-30), newest day implicit. */
  async totals(botId: string, days: number): Promise<Array<{ module: UsageModule; name: string } & UsageTotals>> {
    const window = Math.max(1, Math.min(30, Math.trunc(days) || 1));
    const out = new Map<UsageModule, UsageTotals>();
    for (let back = 0; back < window; back += 1) {
      const date = new Date(this.#now() - back * 86_400_000);
      const day = dayKey(date);
      for (const module of Object.keys(MODULE_NAMES) as UsageModule[]) {
        try {
          const row = await this.#storage.get<UsageTotals>(`${KEY_PREFIX}${botId}:${day}:${module}`);
          if (!row) continue;
          const total = out.get(module) ?? { calls: 0, input: 0, output: 0 };
          total.calls += row.calls;
          total.input += row.input;
          total.output += row.output;
          out.set(module, total);
        } catch (error) {
          this.#logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'usage read failed');
        }
      }
    }
    return [...out.entries()].map(([module, totals]) => ({ module, name: MODULE_NAMES[module], ...totals }));
  }

  async report(botId: string, days: number): Promise<string> {
    const rows = await this.totals(botId, days);
    if (rows.length === 0) return `用量统计（近${days}天）：暂无数据。`;
    const lines = rows.map((row) => `${row.name}：${row.calls} 次 / 输入 ${row.input} / 输出 ${row.output} tokens`);
    const total = rows.reduce(
      (sum, row) => ({ calls: sum.calls + row.calls, input: sum.input + row.input, output: sum.output + row.output }),
      { calls: 0, input: 0, output: 0 },
    );
    lines.push(`总计：${total.calls} 次 / 输入 ${total.input} / 输出 ${total.output} tokens`);
    return [`用量统计（近${days}天）`, ...lines].join('\n');
  }
}

/**
 * Transparent decorator: delegates everything, records successful usage.
 * Constructed in the bot runtime around the resolved provider.
 */
export class UsageRecordingProvider implements AIProvider {
  readonly #inner: AIProvider;
  readonly #recorder: UsageRecorder;
  readonly #botId: string;

  constructor(inner: AIProvider, deps: { recorder: UsageRecorder; botId: string }) {
    this.#inner = inner;
    this.#recorder = deps.recorder;
    this.#botId = deps.botId;
  }

  get name(): string { return this.#inner.name; }
  get model(): string { return this.#inner.model; }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<AIResponse> {
    const response = await this.#inner.chat(messages, options);
    void this.#recorder.record(this.#botId, moduleForTask(options.task), response.usage as UsageNumbers | undefined);
    return response;
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    return this.#inner.health();
  }
}
