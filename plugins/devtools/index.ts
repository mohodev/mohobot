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
import type { EmbedCard, MohoMessage } from '../../src/core/types.js';
import { createProvider } from '../../src/ai/index.js';
import { registerSecret } from '../../src/core/logger.js';
import {
  cmdAi,
  cmdBench,
  cmdClear,
  cmdDiag,
  cmdMemory,
  cmdModels,
  cmdSwitchPersona,
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
    // Read-only session store + live pipeline handle, for user-facing commands.
    sessions: ctx.sessions,
    pipeline: ctx.pipeline,
  };
}

/**
 * Last line of defence. The PluginManager already isolates hook failures, but
 * a debug command that answers "it broke, here is why" is far more useful than
 * one that silently disappears into a log line.
 */
async function guarded(label: string, run: () => Promise<string | EmbedCard | void> | string | EmbedCard | void): Promise<string | EmbedCard> {
  try {
    const r = await run();
    if (typeof r === 'string') return r;
    if (r === undefined || r === null) return '';
    return r;
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

    ctx.registerCommand({
      name: 'act',
      description:
        'Inject <message> into the REAL pipeline as if you sent it (persona + session + command routing). Usage: !act <message>',
      execute: (cmd) =>
        guarded('act', async () => {
          const pipe = context?.pipeline;
          if (!pipe) return '[act] pipeline unavailable (bot not fully started)';
          const text = cmd.args.join(' ').trim();
          if (text.length === 0) return 'usage: !act <message>  (fed into the real pipeline)';
          const src = cmd.message;
          const msg: MohoMessage = {
            id: src.id,
            platform: src.platform,
            botId: src.botId,
            channel: src.channel,
            author: src.author,
            content: text,
            mentionsBot: false,
            attachments: [],
            createdAt: Date.now(),
          };
          await pipe.handle(msg);
          return undefined;
        }),
    });

    ctx.registerCommand({
      name: 'say',
      description: 'Bot speaks into a channel. Usage: !say <text> (current channel) or !say <channelId> <text>.',
      execute: (cmd) =>
        guarded('say', async () => {
          const send = context?.send;
          if (!send) return '[say] send unavailable';
          const args = cmd.args;
          if (args.length === 0) return 'usage: !say <text> | !say <channelId> <text>';
          let channelId: string;
          let text: string;
          if (/^\d{10,}$/.test(args[0])) {
            channelId = args[0];
            text = args.slice(1).join(' ').trim();
          } else {
            channelId = cmd.message.channel.id;
            text = args.join(' ').trim();
          }
          if (text.length === 0) return 'usage: !say <text> (message body empty)';
          await send({ channelId, content: text, suppressMentions: true });
          return undefined;
        }),
    });

    ctx.registerCommand({
      name: '清空',
      description: '清空当前会话上下文（复用内置 !clear 逻辑）。用法: !清空',
      execute: (cmd) => guarded('清空', () => cmdClear(depsFor(ctx), cmd.message)),
    });

    ctx.registerCommand({
      name: '记忆',
      description: '查看当前会话的记忆（近期消息条数与摘要）。用法: !记忆',
      execute: (cmd) => guarded('记忆', () => cmdMemory(depsFor(ctx), cmd.message)),
    });

    ctx.registerCommand({
      name: '换人',
      description: '查看/切换人格：列出 data/prompts 下可用的人格文件。用法: !换人 [人格文件名]',
      execute: (cmd) => guarded('换人', () => cmdSwitchPersona(depsFor(ctx), cmd.args)),
    });

    ctx.logger.info(
      { commands: ['ai', 'models', 'diag', 'bench', 'act', 'say', '清空', '记忆', '换人'], model: ctx.botConfig.ai.model },
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
