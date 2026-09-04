/**
 * perception - environment awareness injected before each AI call.
 *
 * Foreign replacement for the upstream perception plugin (time period,
 * workday/weekend, international holidays, channel context). No Chinese
 * calendar, lunar or solar-term dependency.
 */

import type { Plugin, PluginContext } from '../../src/plugins/types.js';
import { buildEnvironmentBlock, environmentAt } from './perception.js';

let ctx: PluginContext | undefined;

const plugin: Plugin = {
  name: 'perception',

  onLoad(context) {
    ctx = context;
    context.logger.info({ timeZone: String(context.config['timeZone'] ?? 'Asia/Shanghai') }, 'perception plugin ready');
  },

  onUnload() {
    ctx = undefined;
  },

  onBeforeAI(input) {
    if (!ctx) return;
    const timeZone = typeof ctx.config['timeZone'] === 'string' ? ctx.config['timeZone'] : 'Asia/Shanghai';
    if (ctx.config['enabled'] === false) return;
    const env = environmentAt(new Date(), timeZone);
    const block = buildEnvironmentBlock(env, {
      dm: input.message.channel.dm,
      name: input.message.channel.name,
    });
    // Insert after the static system prompt so it reads as a system context note.
    input.messages.splice(1, 0, { role: 'system', content: block });
  },
};

export default plugin;
