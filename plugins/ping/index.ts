/**
 * Reference plugin.
 *
 * Demonstrates the whole plugin surface: onLoad/onUnload, a command,
 * a message hook, scoped storage, and the fact that a thrown error is
 * contained by the PluginManager instead of taking the bot down.
 */

import type { Plugin, PluginContext } from '../../src/plugins/types.js';

let ctx: PluginContext | undefined;
let seen = 0;

const plugin: Plugin = {
  name: 'ping',

  async onLoad(context) {
    ctx = context;
    const previous = (await context.storage.get<number>('seen')) ?? 0;
    seen = previous;
    context.logger.info({ previous }, 'ping plugin ready');

    context.registerCommand({
      name: 'ping',
      description: 'Reply with pong and the messages seen so far.',
      execute: () => `pong (messages seen: ${seen})`,
    });

    context.registerCommand({
      name: 'boom',
      description: 'Throw on purpose - proves plugin errors are isolated.',
      execute: () => {
        throw new Error('intentional plugin failure');
      },
    });
  },

  async onUnload() {
    await ctx?.storage.save('seen', seen);
    ctx?.logger.info({ seen }, 'ping plugin unloaded');
    ctx = undefined;
  },

  onMessage(message) {
    seen += 1;
    // Returning nothing = no opinion; the pipeline continues to the AI.
    if (message.content.trim().toLowerCase() === 'ping') {
      return { stop: true, reply: 'pong' };
    }
    return undefined;
  },
};

export default plugin;
