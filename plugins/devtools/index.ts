/**
 * devtools - an external AI debugging interface for MohoBot.
 *
 * Registers four commands on the running bot (`!ai`, `!models`, `!diag`,
 * `!bench`) so a developer can poke the AI path from any gateway - including
 * the console gateway, with no Discord token and no API key.
 *
 * Nothing in src/ was touched to make this work: commands arrive through
 * `ctx.registerCommand()` and the provider comes from the shared registry.
 */

import type { Plugin, PluginContext } from '../../src/plugins/types.js';
import type { AIProvider } from '../../src/ai/types.js';
import { createProvider } from '../../src/ai/index.js';
import { registerSecret } from '../../src/core/logger.js';
import {
  cmdAi,
  cmdBench,
  cmdDiag,
  cmdModels,
  DEFAULT_REPLY_LIMIT,
  MAX_BENCH_RUNS,
  describeError,
  type DevtoolsDeps,
} from './commands.js';

let cached: AIProvider | undefined;
let context: PluginContext | undefined;

/** Build the provider once, on first use, from the bot's own AI config. */
function providerFor(ctx: PluginContext): AIProvider {
  if (!cached) {
    cached = createProvider(ctx.botConfig.ai, { logger: ctx.logger, botId: ctx.botConfig.id });
  }
  return cached;
}

function depsFor(ctx: PluginContext): DevtoolsDeps {
  const configured = ctx.config['replyLimit'];
  const replyLimit = typeof configured === 'number' && configured > 0 ? configured : DEFAULT_REPLY_LIMIT;
  return {
    getProvider: () => providerFor(ctx),
    // ctx.registry is the plugin-scoped view of the four runtime registries.
    registries: ctx.registry,
    botConfig: ctx.botConfig,
    replyLimit,
  };
}

/**
 * Last line of defence. The PluginManager already isolates hook failures, but
 * a debug command that answers "it broke, here is why" is far more useful than
 * one that silently disappears into a log line.
 */
async function guarded(label: string, run: () => Promise<string> | string): Promise<string> {
  try {
    return await run();
  } catch (error) {
    return `[${label}] internal error: ${describeError(error)}`;
  }
}

const plugin: Plugin = {
  name: 'devtools',

  onLoad(ctx) {
    context = ctx;
    cached = undefined;

    // Belt and braces: make sure this bot's key can never surface in any log
    // line or command output, even if something else echoes it back.
    registerSecret(ctx.botConfig.ai.apiKey);
    registerSecret(ctx.botConfig.discord.token);

    ctx.registerCommand({
      name: 'ai',
      description: 'One-shot AI request that bypasses session history. Usage: !ai <prompt>',
      execute: (cmd) => guarded('ai', () => cmdAi(depsFor(ctx), cmd.args)),
    });

    ctx.registerCommand({
      name: 'models',
      description: 'List AI providers in the runtime registry.',
      execute: () => guarded('models', () => cmdModels(depsFor(ctx))),
    });

    ctx.registerCommand({
      name: 'diag',
      description: 'Diagnostic snapshot: all four registries plus this bot wiring.',
      execute: () => guarded('diag', () => cmdDiag(depsFor(ctx))),
    });

    ctx.registerCommand({
      name: 'bench',
      description: `Latency benchmark. Usage: !bench <n<=${MAX_BENCH_RUNS}> <prompt>`,
      execute: (cmd) => guarded('bench', () => cmdBench(depsFor(ctx), cmd.args)),
    });

    ctx.logger.info(
      { commands: ['ai', 'models', 'diag', 'bench'], model: ctx.botConfig.ai.model },
      'devtools ready - external AI debugging interface',
    );
  },

  onUnload() {
    cached = undefined;
    context?.logger.info('devtools unloaded');
    context = undefined;
  },
};

export default plugin;
