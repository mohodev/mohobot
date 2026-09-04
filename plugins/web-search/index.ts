/**
 * web-search - live web search for MohoBot.
 *
 * Foreign replacement for the upstream anysearch.py client. Defaults to a
 * self-hosted SearXNG instance (no key). `!search <query>` returns the top
 * results. Optional auto-search injects results before the AI call for
 * question-like messages when `autoSearch` is enabled (off by default).
 */

import type { Plugin, PluginContext } from '../../src/plugins/types.js';
import type { SearchConfig, SearchProvider } from './search.js';
import { formatResults, search } from './search.js';

let ctx: PluginContext | undefined;

function resolveConfig(context: PluginContext): SearchConfig {
  const cfg = context.config;
  const provider: SearchProvider = cfg['provider'] === 'brave' ? 'brave' : cfg['provider'] === 'tavily' ? 'tavily' : 'searxng';
  const apiKeyEnv = typeof cfg['apiKeyEnv'] === 'string' ? cfg['apiKeyEnv'] : '';
  const apiKey = apiKeyEnv ? (process.env[apiKeyEnv] ?? '') : '';
  return {
    provider,
    baseUrl: typeof cfg['baseUrl'] === 'string' ? cfg['baseUrl'] : 'https://searx.be',
    apiKey,
    timeoutMs: typeof cfg['timeoutMs'] === 'number' ? cfg['timeoutMs'] : 15000,
    maxResults: typeof cfg['maxResults'] === 'number' ? cfg['maxResults'] : 5,
  };
}

async function doSearch(query: string): Promise<string> {
  if (!ctx) return '搜索未就绪。';
  const results = await search(resolveConfig(ctx), query);
  return formatResults(results, resolveConfig(ctx).maxResults);
}

/** Heuristic for the optional auto-search gate. */
function looksLikeQuestion(text: string): boolean {
  return /[?？]$/.test(text.trim()) || /^(what|who|when|where|how|why|weather|news)\b/i.test(text.trim());
}

const plugin: Plugin = {
  name: 'web-search',

  onLoad(context) {
    ctx = context;
    context.registerCommand({
      name: 'search',
      description: '联网搜索。用法: !search <query>',
      execute: (cmd) => doSearch(cmd.args.join(' ')),
    });
    context.registerCommand({
      name: 'web',
      description: '联网搜索（别名）。用法: !web <query>',
      execute: (cmd) => doSearch(cmd.args.join(' ')),
    });
    context.logger.info({ provider: String(context.config['provider'] ?? 'searxng') }, 'web-search plugin ready');
  },

  onUnload() {
    ctx = undefined;
  },

  async onMessage(message) {
    if (!ctx) return undefined;
    const text = message.content.trim();
    const m = text.match(/^!(?:search|web)\s+(.+)$/i);
    if (!m) return undefined;
    const query = (m[1] ?? '').trim();
    if (!query) return { stop: true, reply: '用法：!search <关键词>' };
    const reply = await doSearch(query);
    return { stop: true, reply };
  },

  async onBeforeAI(input) {
    if (!ctx) return;
    const auto = ctx.config['autoSearch'] === true;
    if (!auto) return;
    const lastUser = [...input.messages].reverse().find((msg) => msg.role === 'user');
    if (!lastUser || !looksLikeQuestion(lastUser.content)) return;
    const results = await search(resolveConfig(ctx), lastUser.content);
    if (results.length === 0) return;
    const block = `[联网搜索结果 - 系统注入]\n${formatResults(results, 3)}`;
    input.messages.splice(1, 0, { role: 'system', content: block });
  },
};

export default plugin;
