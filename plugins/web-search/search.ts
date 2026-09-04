/**
 * Web search client for the web-search plugin.
 *
 * A foreign replacement for the upstream anysearch.py client. Supports:
 *  - SearXNG: self-hosted, JSON API, no key (default, works offline-style with
 *    any public or private instance).
 *  - Brave Search API: monthly free credits, needs an API key.
 *  - Tavily: needs an API key.
 *
 * Only `search()` talks to the network; the parse/URL helpers are pure so they
 * can be unit-tested without a live service.
 */

export type SearchProvider = 'searxng' | 'brave' | 'tavily';

export interface SearchConfig {
  provider: SearchProvider;
  /** SearXNG instance base URL, e.g. https://searx.be */
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  maxResults: number;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export class SearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchError';
  }
}

/** Pure URL builder for SearXNG (tested without a network). */
export function buildSearxngUrl(baseUrl: string, query: string, limit: number): string {
  const base = baseUrl.replace(/\/+$/, '');
  const params = new URLSearchParams({
    q: query,
    format: 'json',
    categories: 'general',
  });
  if (Number.isFinite(limit) && limit > 0) params.set('count', String(limit));
  return `${base}/search?${params.toString()}`;
}

export function parseSearxng(json: unknown): SearchResult[] {
  const results = Array.isArray((json as { results?: unknown[] })?.results)
    ? ((json as { results: unknown[] }).results)
    : [];
  return results.slice(0, 30).flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const row = item as Record<string, unknown>;
    const title = typeof row.title === 'string' ? row.title : '';
    const url = typeof row.url === 'string' ? row.url : '';
    if (!url) return [];
    const snippet = typeof row.content === 'string' ? row.content : typeof row.snippet === 'string' ? row.snippet : '';
    return [{ title, url, snippet }];
  });
}

export function parseBrave(json: unknown): SearchResult[] {
  const results = Array.isArray((json as { web?: { results?: unknown[] } })?.web?.results)
    ? ((json as { web: { results: unknown[] } }).web.results)
    : [];
  return results.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const row = item as Record<string, unknown>;
    const title = typeof row.title === 'string' ? row.title : '';
    const url = typeof row.url === 'string' ? row.url : '';
    if (!url) return [];
    const snippet = typeof row.description === 'string' ? row.description : '';
    return [{ title, url, snippet }];
  });
}

export function parseTavily(json: unknown): SearchResult[] {
  const results = Array.isArray((json as { results?: unknown[] })?.results)
    ? ((json as { results: unknown[] }).results)
    : [];
  return results.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const row = item as Record<string, unknown>;
    const title = typeof row.title === 'string' ? row.title : '';
    const url = typeof row.url === 'string' ? row.url : '';
    if (!url) return [];
    const snippet = typeof row.content === 'string' ? row.content : '';
    return [{ title, url, snippet }];
  });
}

async function fetchText(url: string, init: RequestInit, timeoutMs: number, fetchImpl: typeof fetch): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new SearchError(`search HTTP ${response.status}`);
    return await response.text();
  } catch (error) {
    if (error instanceof SearchError) throw error;
    const aborted = (error as Error)?.name === 'AbortError';
    throw new SearchError(aborted ? `search timed out after ${timeoutMs}ms` : `search request failed: ${(error as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run a web search. Never throws to the caller of the plugin: failures return
 * an empty list (degrade, don't break the reply path).
 */
export async function search(
  config: SearchConfig,
  query: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SearchResult[]> {
  const q = query.trim();
  if (!q) return [];

  try {
    if (config.provider === 'searxng') {
      const url = buildSearxngUrl(config.baseUrl, q, config.maxResults);
      const text = await fetchText(url, { headers: { Accept: 'application/json' } }, config.timeoutMs, fetchImpl);
      return parseSearxng(JSON.parse(text));
    }
    if (config.provider === 'brave') {
      if (!config.apiKey) throw new SearchError('Brave search needs an API key');
      const url = `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q, count: String(config.maxResults) }).toString()}`;
      const text = await fetchText(url, { headers: { 'X-Subscription-Token': config.apiKey, Accept: 'application/json' } }, config.timeoutMs, fetchImpl);
      return parseBrave(JSON.parse(text));
    }
    if (config.provider === 'tavily') {
      if (!config.apiKey) throw new SearchError('Tavily search needs an API key');
      const text = await fetchText('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: config.apiKey, query: q, max_results: config.maxResults }),
      }, config.timeoutMs, fetchImpl);
      return parseTavily(JSON.parse(text));
    }
    throw new SearchError(`unknown search provider: ${String(config.provider)}`);
  } catch (error) {
    // Degrade silently: search is a bonus, never a reason to fail a turn.
    return [];
  }
}

/** Format results for a chat reply, truncated to a sane length. */
export function formatResults(results: SearchResult[], limit = 5): string {
  if (results.length === 0) return '没有找到相关结果。';
  return results.slice(0, limit).map((r, i) => {
    const snippet = r.snippet.length > 280 ? `${r.snippet.slice(0, 280)}…` : r.snippet;
    return `${i + 1}. **${r.title}**\n${r.url}\n${snippet}`;
  }).join('\n\n');
}
