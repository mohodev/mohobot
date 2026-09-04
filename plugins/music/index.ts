/**
 * music - song search via the iTunes Search API.
 *
 * Foreign replacement for the upstream NetEase Cloud Music plugin. `!song`
 * / `!music <关键词>` returns track metadata plus a 30-second preview URL.
 */

import type { Plugin, PluginContext } from '../../src/plugins/types.js';
import { formatTracks, searchItunes } from './itunes.js';

let ctx: PluginContext | undefined;

function limit(): number {
  const configured = ctx?.config['limit'];
  return typeof configured === 'number' && configured > 0 && configured <= 10 ? configured : 3;
}

async function doSearch(query: string): Promise<string> {
  const tracks = await searchItunes(query, limit());
  return formatTracks(tracks, limit());
}

const plugin: Plugin = {
  name: 'music',

  onLoad(context) {
    ctx = context;
    context.registerCommand({
      name: 'song',
      description: '搜索歌曲（iTunes）。用法: !song <关键词>',
      execute: (cmd) => doSearch(cmd.args.join(' ')),
    });
    context.registerCommand({
      name: 'music',
      description: '搜索歌曲（别名）。用法: !music <关键词>',
      execute: (cmd) => doSearch(cmd.args.join(' ')),
    });
    context.logger.info('music plugin ready (iTunes Search API)');
  },

  onUnload() {
    ctx = undefined;
  },

  async onMessage(message) {
    if (!ctx) return undefined;
    const m = message.content.trim().match(/^!(?:song|music)\s+(.+)$/i);
    if (!m) return undefined;
    const query = (m[1] ?? '').trim();
    if (!query) return { stop: true, reply: '用法：!song <关键词>' };
    const reply = await doSearch(query);
    return { stop: true, reply };
  },
};

export default plugin;
