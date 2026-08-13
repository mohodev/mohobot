import type { AIProvider, AIResponse, ChatOptions } from './types.js';
import type { ChatMessage } from '../core/types.js';

/** Tasks are scheduled separately so background cognition cannot starve replies. */
export type ModelTask = 'reply' | 'vision' | 'planner' | 'reflection' | 'profile' | 'world' | 'admin';

export interface ModelBudget {
  /** Rolling one-minute request ceiling. `0` means unlimited. */
  rpm: number;
  /** Reserved capacity never consumed by background tasks. */
  reserveRpm: number;
  /** Upper bound on parallel upstream calls. */
  maxConcurrent: number;
  /** Per-task output budget. Call-site options can only lower it. */
  maxTokens: Partial<Record<ModelTask, number>>;
}

export const DEFAULT_MODEL_BUDGET: ModelBudget = {
  rpm: 34,
  reserveRpm: 6,
  maxConcurrent: 4,
  maxTokens: { reply: 700, vision: 450, planner: 250, reflection: 350, profile: 300, world: 700, admin: 500 },
};

export class ModelBudgetError extends Error {
  constructor(readonly task: ModelTask, readonly reason: 'rate' | 'concurrency') {
    super(`model budget rejected ${task}: ${reason}`);
    this.name = 'ModelBudgetError';
  }
}

/**
 * Local rolling-window guard around any OpenAI-compatible provider. It does
 * not guess vendor quotas: set rpm below the provider contract (e.g. 34 for a
 * 40 RPM endpoint) and reserve capacity for user-facing traffic.
 */
export class BudgetedProvider implements AIProvider {
  readonly #inner: AIProvider;
  readonly #budget: ModelBudget;
  #started: number[] = [];
  #active = 0;

  constructor(inner: AIProvider, budget: Partial<ModelBudget> = {}) {
    this.#inner = inner;
    this.#budget = { ...DEFAULT_MODEL_BUDGET, ...budget, maxTokens: { ...DEFAULT_MODEL_BUDGET.maxTokens, ...budget.maxTokens } };
  }

  get name(): string { return `budgeted:${this.#inner.name}`; }
  get model(): string { return this.#inner.model; }
  async health(): Promise<{ ok: boolean; detail?: string }> { return this.#inner.health(); }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<AIResponse> {
    const task = options.task ?? 'reply';
    this.#admit(task);
    try {
      const ceiling = this.#budget.maxTokens[task];
      const requested = options.maxTokens;
      return await this.#inner.chat(messages, { ...options, maxTokens: ceiling === undefined ? requested : requested === undefined ? ceiling : Math.min(requested, ceiling) });
    } finally {
      this.#active -= 1;
    }
  }

  #admit(task: ModelTask): void {
    const now = Date.now();
    this.#started = this.#started.filter((time) => now - time < 60_000);
    if (this.#active >= this.#budget.maxConcurrent) throw new ModelBudgetError(task, 'concurrency');
    const isInteractive = task === 'reply' || task === 'vision' || task === 'admin';
    const ceiling = isInteractive ? this.#budget.rpm : Math.max(0, this.#budget.rpm - this.#budget.reserveRpm);
    // A zero RPM configuration deliberately disables this local limiter for
    // providers with no known quota. Concurrency and provider-side backoff
    // remain active safeguards.
    if (ceiling > 0 && this.#started.length >= ceiling) throw new ModelBudgetError(task, 'rate');
    this.#started.push(now);
    this.#active += 1;
  }
}
