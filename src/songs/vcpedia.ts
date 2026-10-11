/**
 * VCPedia song sync: category listing -> wikitext -> parsed records.
 *
 * Follows upstream `mohobot/music_knowledge/vcpedia.py`, minus the Anubis PoW
 * client: the read path used here (`api.php list=categorymembers` +
 * `prop=revisions rvprop=content`) answers cleanly without challenges; only
 * rest.php/rendered HTML sits behind Anubis. Fetch is injectable for tests.
 */

import { parseSongPage, type SongDetail } from './song.js';

export interface VcpediaSyncConfig {
  baseUrl: string;
  category: string;
  userAgent: string;
  /** Parallel page fetches. */
  concurrency: number;
  /** Polite gap between list pages (ms). */
  listDelayMs: number;
  requestTimeoutMs: number;
}

export const DEFAULT_VCPEDIA_CONFIG: VcpediaSyncConfig = {
  baseUrl: 'https://vcpedia.cn',
  category: 'Category:洛天依歌曲',
  userAgent: 'Mozilla/5.0 (compatible; MohoBot/1.0)',
  concurrency: 4,
  listDelayMs: 300,
  requestTimeoutMs: 25000,
};

export interface SyncResult {
  listed: number;
  added: string[];
  failed: Array<{ title: string; reason: string }>;
  skipped: number;
}

async function fetchJson(url: string, config: VcpediaSyncConfig, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { 'User-Agent': config.userAgent },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

function apiUrl(config: VcpediaSyncConfig, params: Record<string, string>): string {
  const query = new URLSearchParams({ format: 'json', ...params }).toString();
  return `${config.baseUrl.replace(/\/$/, '')}/api.php?${query}`;
}

/** All main-namespace titles in the category, following continuation. */
export async function listCategoryTitles(
  config: VcpediaSyncConfig,
  fetchImpl: typeof fetch = fetch,
  onProgress?: (listed: number) => void,
): Promise<string[]> {
  const titles: string[] = [];
  let cmcontinue: string | undefined;
  for (;;) {
    const data = (await fetchJson(
      apiUrl(config, {
        action: 'query',
        list: 'categorymembers',
        cmtitle: config.category,
        cmnamespace: '0',
        cmlimit: '500',
        ...(cmcontinue ? { cmcontinue } : {}),
      }),
      config,
      fetchImpl,
    )) as { query?: { categorymembers?: Array<{ title?: string }> }; continue?: { cmcontinue?: string } };
    for (const member of data?.query?.categorymembers ?? []) {
      if (typeof member.title === 'string' && member.title) titles.push(member.title);
    }
    onProgress?.(titles.length);
    cmcontinue = data?.continue?.cmcontinue;
    if (!cmcontinue) break;
    await new Promise((resolve) => setTimeout(resolve, config.listDelayMs));
  }
  return titles;
}

async function fetchWikitext(
  title: string,
  config: VcpediaSyncConfig,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const data = (await fetchJson(
    apiUrl(config, {
      action: 'query',
      prop: 'revisions',
      rvprop: 'content',
      rvslots: 'main',
      titles: title,
    }),
    config,
    fetchImpl,
  )) as { query?: { pages?: Record<string, { revisions?: Array<{ slots?: { main?: { '*'?: string } } }> }> } };
  const pages = data?.query?.pages ?? {};
  for (const page of Object.values(pages)) {
    const slots = page?.revisions?.[0]?.slots?.main;
    if (slots && typeof slots['*'] === 'string') return slots['*'];
  }
  return null;
}

/**
 * Full sync: list, fetch, parse, upsert. `upsert` persists one record and
 * returns false for skipped pages. Concurrency-bounded with per-title errors
 * collected, never thrown.
 */
export async function syncVcpedia(
  config: VcpediaSyncConfig,
  upsert: (detail: SongDetail) => Promise<boolean>,
  fetchImpl: typeof fetch = fetch,
  onProgress?: (done: number, total: number) => void,
  maxTitles = 0,
): Promise<SyncResult> {
  const listed = await listCategoryTitles(config, fetchImpl);
  const titles = maxTitles > 0 ? listed.slice(0, maxTitles) : listed;
  const result: SyncResult = { listed: listed.length, added: [], failed: [], skipped: 0 };
  let done = 0;
  const queue = [...titles];
  const workers = Array.from({ length: Math.max(1, config.concurrency) }, async () => {
    for (;;) {
      const title = queue.shift();
      if (title === undefined) break;
      try {
        const wikitext = await fetchWikitext(title, config, fetchImpl);
        if (!wikitext) {
          result.skipped += 1;
        } else {
          const detail = parseSongPage(title, wikitext);
          if (!detail) {
            result.skipped += 1;
          } else if (await upsert(detail)) {
            result.added.push(detail.name);
          } else {
            result.skipped += 1;
          }
        }
      } catch (error) {
        result.failed.push({ title, reason: error instanceof Error ? error.message : String(error) });
      } finally {
        done += 1;
        onProgress?.(done, titles.length);
      }
    }
  });
  await Promise.all(workers);
  return result;
}
