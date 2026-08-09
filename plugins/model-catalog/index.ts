/**
 * model-catalog plugin.
 *
 * Commands
 *   !freemodels          list every ':free' model (cached, TTL configurable)
 *   !modelinfo <id>      context window, max completion, pricing, parameters
 *   !lint                metadata quality report for the whole catalog
 *   !probefree           serial health probe of the free models (manual only)
 *
 * Constraints honoured here:
 *   - no console.*; every diagnostic goes through ctx.logger
 *   - the API key is read from the environment, registered as a secret, and
 *     never written to storage, logs or command output
 *   - no command may throw: failures come back as one readable line
 *   - src/ is untouched; this plugin only consumes the published contracts
 */

import { registerSecret } from '../../src/core/logger.js';
import type { Plugin, PluginContext } from '../../src/plugins/types.js';
import {
  filterFree,
  findModel,
  formatFreeList,
  formatLintReport,
  formatModelInfo,
  lintCatalog,
  suggestModels,
  type CatalogModel,
} from './catalog.js';
import { CatalogClient, DEFAULT_BASE_URL, type CatalogSnapshot } from './client.js';

/** Discord hard-caps a message at 2000 characters. */
const MAX_REPLY = 1900;

interface ResolvedPluginConfig {
  baseUrl: string;
  apiKeyEnv: string;
  ttlSeconds: number;
  timeoutMs: number;
  lintPreview: number;
  probeEnabled: boolean;
  probeTimeoutMs: number;
  probeBudgetMs: number;
  probeLimit: number;
}

function readNumber(source: Record<string, unknown>, key: string, fallback: number): number {
  const value = source[key];
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function readString(source: Record<string, unknown>, key: string, fallback: string): string {
  const value = source[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

function readBoolean(source: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = source[key];
  return typeof value === 'boolean' ? value : fallback;
}

export function resolveConfig(raw: Record<string, unknown>): ResolvedPluginConfig {
  return {
    baseUrl: readString(raw, 'baseUrl', DEFAULT_BASE_URL),
    apiKeyEnv: readString(raw, 'apiKeyEnv', 'KILO_API_KEY'),
    ttlSeconds: readNumber(raw, 'cacheTtlSeconds', 3600),
    timeoutMs: readNumber(raw, 'requestTimeoutMs', 15_000),
    lintPreview: readNumber(raw, 'lintPreviewCount', 10),
    probeEnabled: readBoolean(raw, 'probeEnabled', true),
    probeTimeoutMs: readNumber(raw, 'probeTimeoutMs', 20_000),
    probeBudgetMs: readNumber(raw, 'probeBudgetMs', 90_000),
    probeLimit: readNumber(raw, 'probeLimit', 10),
  };
}

function clamp(text: string): string {
  return text.length <= MAX_REPLY ? text : `${text.slice(0, MAX_REPLY - 20)}\n\u2026(truncated)`;
}

function ageLine(snapshot: CatalogSnapshot, now: number): string {
  const seconds = Math.max(0, Math.round((now - snapshot.fetchedAt) / 1000));
  const suffix = snapshot.warning === undefined ? '' : ` - ${snapshot.warning}`;
  return `_source: ${snapshot.source}, age ${seconds}s${suffix}_`;
}

function failure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Could not read the model catalog: ${message}`;
}

let ctx: PluginContext | undefined;
let client: CatalogClient | undefined;
let settings: ResolvedPluginConfig | undefined;
let probing = false;

async function snapshot(force = false): Promise<CatalogSnapshot> {
  if (!client) throw new Error('plugin is not loaded');
  return client.getModels({ force });
}

function models(current: CatalogSnapshot): CatalogModel[] {
  return current.models;
}

const plugin: Plugin = {
  name: 'model-catalog',

  onLoad(context) {
    ctx = context;
    const config = resolveConfig(context.config);
    settings = config;

    const apiKey = process.env[config.apiKeyEnv];
    // Belt and braces: even if some other component echoes the key, the logger
    // will now mask it everywhere.
    registerSecret(apiKey);

    client = new CatalogClient({
      apiKey,
      baseUrl: config.baseUrl,
      ttlSeconds: config.ttlSeconds,
      timeoutMs: config.timeoutMs,
      storage: context.storage,
      logger: context.logger,
    });

    context.logger.info(
      {
        baseUrl: config.baseUrl,
        ttlSeconds: config.ttlSeconds,
        credentials: apiKey ? 'present' : 'missing',
      },
      'model-catalog plugin ready',
    );

    context.registerCommand({
      name: 'freemodels',
      description: 'List the models the gateway offers for free (:free suffix).',
      async execute(command) {
        try {
          const force = command.args.includes('--refresh');
          const current = await snapshot(force);
          const free = filterFree(models(current));
          return clamp(
            [
              formatFreeList(free),
              '',
              `${models(current).length} models in catalog. ${ageLine(current, Date.now())}`,
            ].join('\n'),
          );
        } catch (error) {
          context.logger.error({ err: error }, 'freemodels failed');
          return failure(error);
        }
      },
    });

    context.registerCommand({
      name: 'modelinfo',
      description: 'Show context window, pricing and parameters for one model id.',
      async execute(command) {
        const query = command.args.join(' ').trim();
        if (query === '') return 'Usage: `!modelinfo <model-id>` (try `!freemodels` for ideas).';
        try {
          const current = await snapshot();
          const model = findModel(models(current), query);
          if (!model) {
            const hints = suggestModels(models(current), query);
            return hints.length > 0
              ? `No exact match for \`${query}\`. Did you mean:\n${hints.map((id) => `- \`${id}\``).join('\n')}`
              : `No model matches \`${query}\`.`;
          }
          return clamp(`${formatModelInfo(model)}\n\n${ageLine(current, Date.now())}`);
        } catch (error) {
          context.logger.error({ err: error }, 'modelinfo failed');
          return failure(error);
        }
      },
    });

    context.registerCommand({
      name: 'lint',
      description: 'Report metadata quality problems across the whole model catalog.',
      async execute(command) {
        try {
          const force = command.args.includes('--refresh');
          const current = await snapshot(force);
          const all = models(current);
          const issues = lintCatalog(all);
          context.logger.info({ issues: issues.length, models: all.length }, 'catalog lint complete');
          return clamp(
            `${formatLintReport(issues, all.length, config.lintPreview)}\n\n${ageLine(current, Date.now())}`,
          );
        } catch (error) {
          context.logger.error({ err: error }, 'lint failed');
          return failure(error);
        }
      },
    });

    context.registerCommand({
      name: 'probefree',
      description: 'Manually probe every free model with a one-token request (serial, budgeted).',
      async execute() {
        if (!config.probeEnabled) return 'Probing is disabled by plugin config (`probeEnabled: false`).';
        if (probing) return 'A probe is already running; wait for it to finish.';
        probing = true;
        try {
          const current = await snapshot();
          const free = filterFree(models(current));
          if (free.length === 0) return 'No :free models to probe.';
          if (!client) throw new Error('plugin is not loaded');

          const started = Date.now();
          const results = await client.probeModels(
            free.map((model) => model.id),
            {
              timeoutMs: config.probeTimeoutMs,
              budgetMs: config.probeBudgetMs,
              limit: config.probeLimit,
            },
          );
          const working = results.filter((result) => result.ok);
          const lines = results.map((result) =>
            result.ok
              ? `- OK   \`${result.modelId}\` (${result.latencyMs}ms)`
              : `- FAIL \`${result.modelId}\` ${result.reason ?? 'unknown'}`,
          );
          context.logger.info(
            { probed: results.length, working: working.length },
            'free model probe complete',
          );
          return clamp(
            [
              `**${working.length}/${results.length} free model(s) answered** in ${
                Date.now() - started
              }ms`,
              ...lines,
            ].join('\n'),
          );
        } catch (error) {
          context.logger.error({ err: error }, 'probefree failed');
          return failure(error);
        } finally {
          probing = false;
        }
      },
    });
  },

  onUnload() {
    client?.clearMemoryCache();
    ctx?.logger.info({}, 'model-catalog plugin unloaded');
    client = undefined;
    settings = undefined;
    probing = false;
    ctx = undefined;
  },
};

/** Exposed for tests / diagnostics; undefined until onLoad runs. */
export function currentSettings(): ResolvedPluginConfig | undefined {
  return settings;
}

export default plugin;
