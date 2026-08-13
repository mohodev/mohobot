/**
 * AI layer barrel + provider resolution.
 *
 * Built-in providers register themselves here. Adding a new backend (Anthropic
 * native, Gemini, a local runner) means calling
 * `registries.providers.register('name', factory)` from a plugin or an
 * extensions module - NOT editing this file.
 */

import type { AIConfig } from '../config/schema.js';
import type { EventBus } from '../core/event.js';
import type { Logger } from '../core/logger.js';
import { registries, type ProviderFactory } from '../core/registries.js';
import { MockProvider } from './mock.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import type { AIProvider } from './types.js';
import { BudgetedProvider } from './router.js';
import { isProviderProfiles, MultiProviderRouter, type TaskRoute } from './multi-router.js';

export * from './types.js';
export * from './openai-compatible.js';
export * from './mock.js';

export interface CreateProviderDeps {
  logger: Logger;
  events?: EventBus;
  botId?: string;
  /** Injectable fetch, forwarded to the HTTP provider (tests). */
  fetchImpl?: typeof fetch;
}

export const BUILTIN_PROVIDER = 'openai-compatible';
export const MOCK_PROVIDER = 'mock';

const openAIFactory: ProviderFactory = (cfg, deps) => new OpenAICompatibleProvider(cfg, deps);
const mockFactory: ProviderFactory = (cfg) =>
  new MockProvider({ model: cfg.model === 'mock' ? 'mock' : `mock:${cfg.model}` });

/** Register the built-ins. Idempotent, so repeated imports are safe. */
export function registerBuiltinProviders(): void {
  if (!registries.providers.has(BUILTIN_PROVIDER)) {
    registries.providers.register(BUILTIN_PROVIDER, openAIFactory, {
      source: 'builtin',
      description: 'Any OpenAI-compatible /chat/completions endpoint',
    });
  }
  if (!registries.providers.has(MOCK_PROVIDER)) {
    registries.providers.register(MOCK_PROVIDER, mockFactory, {
      source: 'builtin',
      description: 'Offline canned responses; used when no credentials are set',
    });
  }
}

registerBuiltinProviders();

/**
 * Resolve a provider from config.
 *
 * Selection order:
 *  1. model === 'mock'                 -> mock (explicit offline mode)
 *  2. the resolved provider declares it needs a credential that is absent
 *     (default rule: cfg.apiKey empty; a plugin may declare its own key source)
 *                                      -> mock (never crash on missing keys)
 *  3. explicit `ai.provider` name      -> registry lookup
 *  4. default                          -> openai-compatible
 *
 * An unknown provider name degrades to the built-in with a warning rather than
 * taking the bot down.
 */
export function createProvider(cfg: AIConfig, deps: CreateProviderDeps): AIProvider {
  const profiles = cfg.options['profiles'];
  const routes = cfg.options['taskRoutes'];
  const defaultProfile = cfg.options['defaultProfile'];
  if (isProviderProfiles(profiles) && typeof defaultProfile === 'string' && profiles[defaultProfile]) {
    return new MultiProviderRouter({
      profiles,
      routes: (routes && typeof routes === 'object' && !Array.isArray(routes) ? routes : {}) as Partial<Record<import('./router.js').ModelTask, TaskRoute>>,
      defaultProfile,
      logger: deps.logger,
    });
  }

  const requested = (cfg.provider ?? BUILTIN_PROVIDER).trim() || BUILTIN_PROVIDER;
  const resolved = registries.providers.has(requested) ? requested : BUILTIN_PROVIDER;
  if (resolved !== requested) {
    deps.logger.warn(
      { requested, fallback: BUILTIN_PROVIDER, available: registries.providers.names() },
      'unknown AI provider; falling back',
    );
  }

  const useMock = cfg.model === MOCK_PROVIDER || registries.providers.needsKey(resolved, cfg);
  if (useMock) {
    deps.logger.warn(
      {
        botId: deps.botId,
        model: cfg.model,
        provider: resolved,
        reason:
          cfg.model === MOCK_PROVIDER
            ? 'model=mock'
            : `provider ${resolved} needs a credential that is not configured`,
      },
      'AI running in MOCK mode - replies are canned. Configure the provider credential for live completions.',
    );
    return registries.providers.require(MOCK_PROVIDER)(cfg, deps);
  }

  const provider = registries.providers.require(resolved)(cfg, deps);
  const budget = cfg.options['budget'];
  if (budget && typeof budget === 'object' && !Array.isArray(budget)) {
    return new BudgetedProvider(provider, budget as Partial<import('./router.js').ModelBudget>);
  }
  return provider;
}
