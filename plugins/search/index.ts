/**
 * Web search plugin: Anysearch -> DuckDuckGo -> Wikipedia.
 *
 * Follows upstream's data sources (`mohobot/anysearch.py`): the Anysearch MCP
 * API (`https://api.anysearch.com/mcp`, JSON-RPC search/batch/extract) is the
 * primary backend - it answers without a key. DuckDuckGo (Instant Answer +
 * HTML scrape) covers networks where Anysearch is unreachable, and Wikipedia
 * (opensearch + summary) is the universal fallback that works from anywhere.
 * All three run concurrently; the first non-empty result in backend order
 * wins. Anything failing degrades to the next backend, never to the user.
 *
 * Trigger `搜索 <关键词>` or `/搜索 <关键词>` answers directly (no model
 * call). An explicit invocation with zero results says so; only transport
 * failures fall through to the AI silently.
 */

import type { Plugin } from '../../src/plugins/types.js';
import type { MohoMessage } from '../../src/core/types.js';

export interface SearchResult {
  title: string;
  snippet: string;
  url: string;
  source: 'anysearch' | 'duckduckgo' | 'wikipedia';
}

export interface SearchConfig {
  backends: string[];
  maxResults: number;
  timeoutMs: number;
  anysearchUrl: string;
  anysearchKey: string;
}

export const DEFAULT_SEARCH_CONFIG: SearchConfig = {
  backends: ['anysearch', 'duckduckgo', 'wikipedia'],
  maxResults: 3,
  timeoutMs: 12000,
  anysearchUrl: 'https://api.anysearch.com/mcp',
  anysearchKey: '',
};

const SEARCH_PATTERN = /^(?:\/)?搜索[\s　：:]+(.+)$/s;
const HELP_PATTERN = /^(?:\/)?搜索[\s　：:]*$/;

export function parseSearchCommand(text: string): string | null {
  const trimmed = text.trim();
  if (HELP_PATTERN.test(trimmed)) return '';
  const match = trimmed.match(SEARCH_PATTERN);
  const query = match?.[1]?.trim() ?? '';
  return query ? query : null;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
  ]).finally(() => clearTimeout(timer));
}

async function postJson(url: string, body: unknown, timeoutMs: number, apiKey = ''): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) return null;
    return (await response.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function getText(url: string, timeoutMs: number, headers: Record<string, string> = {}): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MohoBot/1.0)', ...headers },
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Anysearch MCP search: same endpoint and protocol as upstream anysearch.py. */
export async function searchAnysearch(query: string, cfg: SearchConfig): Promise<SearchResult[]> {
  const data = await postJson(
    cfg.anysearchUrl,
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: { query, max_results: cfg.maxResults } } },
    cfg.timeoutMs,
    cfg.anysearchKey,
  ) as { result?: { content?: Array<{ type?: string; text?: string }> } } | null;
  if (!data) throw new Error('anysearch unreachable');
  const texts = (data?.result?.content ?? [])
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text as string);
  const combined = texts.join('\n');
  return parseAnysearchMarkdown(combined, cfg.maxResults);
}

/** Parses the `### N. Title\n- **URL**: ...` markdown Anysearch returns. */
export function parseAnysearchMarkdown(markdown: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = markdown.split(/^### \d+\. /m).slice(1);
  for (const block of blocks) {
    if (results.length >= limit) break;
    const lines = block.split('\n');
    const title = (lines[0] ?? '').trim();
    const urlLine = lines.find((line) => line.includes('**URL**'));
    const url = urlLine?.split('**URL**:')[1]?.trim() ?? '';
    const snippet = lines
      .filter((line) => line.startsWith('- ') && !line.includes('**URL**'))
      .map((line) => line.slice(2).trim())
      .filter(Boolean)
      .slice(0, 2)
      .join(' ');
    if (!title || !url) continue;
    results.push({ title, snippet, url, source: 'anysearch' });
  }
  return results;
}

/** DuckDuckGo Instant Answer API (stable JSON, no key). Often sparse. */
export async function searchDuckDuckGoIa(query: string, timeoutMs: number): Promise<SearchResult[]> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const text = await getText(url, timeoutMs);
  if (!text) throw new Error('duckduckgo IA unreachable');
  let data: {
    Abstract?: string; AbstractURL?: string; Heading?: string; Answer?: string;
    RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: Array<{ Text?: string; FirstURL?: string }> }>;
  };
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    return [];
  }
  const results: SearchResult[] = [];
  if (data.Abstract && data.AbstractURL) {
    results.push({ title: data.Heading || query, snippet: data.Abstract.slice(0, 200), url: data.AbstractURL, source: 'duckduckgo' });
  } else if (data.Answer) {
    results.push({ title: query, snippet: data.Answer.slice(0, 200), url: '', source: 'duckduckgo' });
  }
  for (const topic of data.RelatedTopics ?? []) {
    const flat = topic.Topics ?? (topic.Text ? [topic] : []);
    for (const item of flat) {
      if (item.Text && item.FirstURL) results.push({ title: item.Text.split(' - ')[0] || query, snippet: item.Text.slice(0, 200), url: item.FirstURL, source: 'duckduckgo' });
    }
  }
  return results;
}

/** DuckDuckGo HTML results (works where the IP is not challenged). */
export async function searchDuckDuckGoHtml(query: string, timeoutMs: number): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const html = await getText(url, timeoutMs, { Referer: 'https://duckduckgo.com/' });
  if (!html) throw new Error('duckduckgo unreachable');
  if (html.includes('anomaly-modal')) throw new Error('duckduckgo challenged');
  return parseDuckDuckGoHtml(html);
}

/** Parses result blocks; tolerant - unknown markup degrades to []. */
export function parseDuckDuckGoHtml(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const blockPattern = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetPattern = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/;
  let match: RegExpExecArray | null;
  while ((match = blockPattern.exec(html)) !== null && results.length < 5) {
    const rawHref = match[1] ?? '';
    const hrefMatch = rawHref.match(/[?&]uddg=([^&]+)/);
    const url = hrefMatch?.[1] ? decodeURIComponent(hrefMatch[1]) : rawHref;
    if (!/^https?:\/\//.test(url)) continue;
    const title = match[2]?.replace(/<[^>]+>/g, '').trim() ?? '';
    const after = html.slice(match.index, match.index + 4000);
    const snippet = (after.match(snippetPattern)?.[1] ?? '').replace(/<[^>]+>/g, '').trim().slice(0, 200);
    if (!title) continue;
    results.push({ title, snippet, url, source: 'duckduckgo' });
  }
  return results;
}

/** Wikipedia opensearch + summary: the fallback that works from anywhere. */
export async function searchWikipedia(query: string, timeoutMs: number): Promise<SearchResult[]> {
  const searchUrl = `https://zh.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=3&format=json`;
  const found = await getText(searchUrl, timeoutMs);
  if (!found) throw new Error('wikipedia unreachable');
  let titles: string[] = [];
  try {
    const parsed = JSON.parse(found) as unknown[];
    if (Array.isArray(parsed?.[1])) titles = (parsed[1] as unknown[]).filter((t): t is string => typeof t === 'string');
  } catch {
    return [];
  }
  if (titles.length === 0) return [];
  const title = titles[0]!;
  const summary = await getText(`https://zh.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, timeoutMs);
  if (!summary) return [];
  try {
    const page = JSON.parse(summary) as { title?: string; description?: string; extract?: string; content_urls?: { desktop?: { page?: string } } };
    if (!page.title) return [];
    const snippet = [page.description, (page.extract ?? '').slice(0, 200)].filter(Boolean).join('：');
    return [{ title: page.title, snippet, url: page.content_urls?.desktop?.page ?? '', source: 'wikipedia' }];
  } catch {
    return [];
  }
}

export function formatResults(query: string, results: SearchResult[]): string {
  const icons: Record<SearchResult['source'], string> = { anysearch: '🔍', duckduckgo: '🦆', wikipedia: '📖' };
  const lines = results.slice(0, 3).map((result, index) => {
    const head = `${index + 1}. ${result.title}`;
    const body = result.snippet ? `\n   ${result.snippet}` : '';
    const link = result.url ? `\n   ${result.url}` : '';
    return head + body + link;
  });
  return [`${icons[results[0]!.source]} 搜索：${query}`, ...lines].join('\n');
}

const plugin: Plugin = {
  name: 'search',
  triggers: [/^(?:\/)?搜索[\s　：:]/],

  async onMessage(message: MohoMessage, ctx) {
    if (message.author.bot) return undefined;
    const query = parseSearchCommand(message.content);
    if (query === null) return undefined;
    if (!query) return { stop: true, reply: '用法：`搜索 <关键词>`（如：搜索 洛天依 新歌）。' };

    const raw = (ctx.config ?? {}) as Partial<SearchConfig>;
    const cfg: SearchConfig = {
      ...DEFAULT_SEARCH_CONFIG,
      ...(typeof raw.backends !== 'undefined' ? { backends: raw.backends } : {}),
      ...(typeof raw.maxResults !== 'undefined' ? { maxResults: raw.maxResults } : {}),
      ...(typeof raw.timeoutMs !== 'undefined' ? { timeoutMs: raw.timeoutMs } : {}),
      ...(typeof raw.anysearchUrl !== 'undefined' ? { anysearchUrl: raw.anysearchUrl } : {}),
      ...(typeof raw.anysearchKey !== 'undefined' ? { anysearchKey: raw.anysearchKey } : {}),
    };
    const backends = (Array.isArray(cfg.backends) ? cfg.backends : []).map(String);
    const attempts: Record<string, () => Promise<SearchResult[]>> = {
      anysearch: () => searchAnysearch(query, cfg),
      duckduckgo: async () => {
        const [ia, html] = await Promise.all([
          searchDuckDuckGoIa(query, cfg.timeoutMs),
          searchDuckDuckGoHtml(query, cfg.timeoutMs),
        ]);
        return [...html, ...ia].slice(0, cfg.maxResults);
      },
      wikipedia: () => searchWikipedia(query, cfg.timeoutMs),
    };
    let anySucceeded = false;
    for (const name of backends) {
      const run = attempts[name];
      if (!run) continue;
      let results: SearchResult[] | null = null;
      try {
        results = await withTimeout(run(), cfg.timeoutMs + 2000);
      } catch {
        continue; // transport failure: next backend, never the user
      }
      if (results === null) continue; // timed out: next backend
      anySucceeded = true;
      if (results.length > 0) {
        return { stop: true, reply: formatResults(query, results.slice(0, cfg.maxResults)) };
      }
    }
    if (anySucceeded) {
      return { stop: true, reply: `没搜到「${query}」相关结果，换个词试试？` };
    }
    // Every backend errored: stay silent and let the AI answer from its own
    // knowledge instead of sending a dead-end message.
    return undefined;
  },
};

export default plugin;
