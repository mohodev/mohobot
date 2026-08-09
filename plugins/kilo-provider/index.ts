/**
 * kilo-provider plugin entry point.
 *
 * The entire deliverable of this plugin is one registry call: it adds the
 * `kilo` AI provider to the running bot with ZERO changes under src/, which is
 * the claim docs/EXTENDING.md makes. Entries registered from a plugin are
 * auto-tagged `plugin:<id>` and reaped on unload, so hot reload cannot leak a
 * dead factory or trip the "already registered" guard.
 *
 * Select it from a bot yaml:
 *
 *   ai:
 *     provider: kilo
 *     model: tencent/hy3:free
 *     maxTokens: 2048
 *
 * The API key is never stored here: it comes from ai.apiKey (env-injected by
 * the config loader) or directly from KILO_API_KEY. A missing key does NOT stop
 * the plugin loading - the factory is still registered and the failure surfaces
 * as a clear AIError on the first chat() call.
 */

import type { Plugin, PluginContext } from '../../src/plugins/types.js';
import { KILO_PROVIDER_NAME, createKiloProviderFactory } from './provider.js';

let ctx: PluginContext | undefined;

// The kilo credential lives in KILO_API_KEY, not the shared AI_API_KEY. Declaring
// it here lets the framework treat the provider as usable when KILO_API_KEY is set
// (via the generic needsKey hook) instead of forcing AI_API_KEY on every bot.
function kiloNeedsKey(cfg: { apiKey?: unknown }): boolean {
  const fromConfig = typeof cfg.apiKey === 'string' && cfg.apiKey.trim() !== '';
  const fromEnv = typeof process.env.KILO_API_KEY === 'string' && process.env.KILO_API_KEY.trim() !== '';
  return !fromConfig && !fromEnv;
}

const plugin: Plugin = {
  name: 'kilo-provider',

  onLoad(context) {
    ctx = context;

    const factory = createKiloProviderFactory(context.config);
    context.registry.providers.register(KILO_PROVIDER_NAME, factory, {
      source: `plugin:${context.pluginId}`,
      description: 'Kilo AI gateway (OpenAI-compatible, reasoning-aware, 200-with-error safe)',
      needsKey: kiloNeedsKey,
    });

    context.logger.info(
      {
        provider: KILO_PROVIDER_NAME,
        hasKey: Boolean(process.env.KILO_API_KEY) || Boolean(context.botConfig?.ai?.apiKey),
        baseUrl: context.config.baseUrl,
        defaultModel: context.config.defaultModel,
      },
      'kilo provider registered',
    );

    if (!process.env.KILO_API_KEY && !context.botConfig?.ai?.apiKey) {
      context.logger.warn(
        { provider: KILO_PROVIDER_NAME },
        'KILO_API_KEY is not set - the kilo provider is registered but every chat() call will fail with an auth AIError',
      );
    }
  },

  onUnload() {
    ctx?.logger.info({ provider: KILO_PROVIDER_NAME }, 'kilo provider plugin unloaded');
    ctx = undefined;
  },
};

export default plugin;
