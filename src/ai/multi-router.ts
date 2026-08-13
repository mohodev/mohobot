import type { AIConfig } from '../config/schema.js';
import type { ChatMessage } from '../core/types.js';
import type { Logger } from '../core/logger.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { BudgetedProvider, type ModelBudget, type ModelTask } from './router.js';
import type { AIProvider, AIResponse, ChatOptions } from './types.js';

export interface ProviderProfile {
  baseUrl: string;
  apiKey?: string;
  model: string;
  budget?: Partial<ModelBudget>;
}
export interface TaskRoute { primary: string; fallback?: string; }

/** Routes task lanes to named OpenAI-compatible profiles with bounded fallback. */
export class MultiProviderRouter implements AIProvider {
  readonly #profiles: Map<string, AIProvider>;
  readonly #routes: Partial<Record<ModelTask, TaskRoute>>;
  readonly #default: string;

  constructor(input: { profiles: Record<string, ProviderProfile>; routes: Partial<Record<ModelTask, TaskRoute>>; defaultProfile: string; logger: Logger }) {
    this.#profiles = new Map(Object.entries(input.profiles).map(([id, profile]) => {
      const cfg = { provider: 'openai-compatible', baseUrl: profile.baseUrl, apiKey: profile.apiKey ?? '', model: profile.model, temperature: .7, maxTokens: 1024, timeoutMs: 60_000, retries: 2, retryBaseDelayMs: 500, stream: false, fallbackReply: '', options: {} } satisfies AIConfig;
      return [id, new BudgetedProvider(new OpenAICompatibleProvider(cfg, { logger: input.logger.child({ providerProfile: id }) }), profile.budget)];
    }));
    this.#routes = input.routes;
    this.#default = input.defaultProfile;
  }

  get name(): string { return 'multi-provider-router'; }
  get model(): string { return this.#profiles.get(this.#default)?.model ?? 'unconfigured'; }
  async health(): Promise<{ ok: boolean; detail?: string }> {
    const provider = this.#profiles.get(this.#default);
    return provider ? provider.health() : { ok: false, detail: 'default provider profile missing' };
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<AIResponse> {
    const task = options.task ?? 'reply';
    const route = this.#routes[task] ?? { primary: this.#default };
    const primary = this.#profiles.get(route.primary);
    if (!primary) throw new Error(`provider profile not found: ${route.primary}`);
    try { return await primary.chat(messages, options); }
    catch (error) {
      const fallback = route.fallback ? this.#profiles.get(route.fallback) : undefined;
      if (!fallback) throw error;
      return fallback.chat(messages, options);
    }
  }
}

export function isProviderProfiles(value: unknown): value is Record<string, ProviderProfile> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every((profile) => {
    const candidate = profile as Partial<ProviderProfile>;
    return typeof candidate.baseUrl === 'string' && typeof candidate.model === 'string';
  });
}
