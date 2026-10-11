import { describe, expect, it, vi } from 'vitest';

import { listCategoryTitles, syncVcpedia, DEFAULT_VCPEDIA_CONFIG } from './vcpedia.js';

const config = { ...DEFAULT_VCPEDIA_CONFIG, baseUrl: 'https://vcpedia.test', listDelayMs: 0 };

function jsonResponse(data: unknown) {
  return { ok: true, json: async () => data } as Response;
}

describe('listCategoryTitles', () => {
  it('follows continuation across pages', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        query: { categorymembers: [{ title: '歌A' }, { title: '歌B' }] },
        continue: { cmcontinue: 'next' },
      }))
      .mockResolvedValueOnce(jsonResponse({ query: { categorymembers: [{ title: '歌C' }] } }));
    const titles = await listCategoryTitles(config, fetchImpl as never);
    expect(titles).toEqual(['歌A', '歌B', '歌C']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain('cmcontinue=next');
  });

  it('skips members without titles', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({ query: { categorymembers: [{}, { title: '' }, { title: '歌A' }] } }));
    expect(await listCategoryTitles(config, fetchImpl as never)).toEqual(['歌A']);
  });
});

const REVISION = (source: string) => ({
  query: { pages: { '1': { revisions: [{ slots: { main: { '*': source } } }] } } },
});

const SONG_PAGE = [
  '{{VOCALOID_Songbox',
  '|演唱 = [[洛天依]]',
  '|歌曲名称 = 同步之歌',
  '|UP主 = [[测试UP]]',
  '}}',
  '== 歌词 ==',
  '<poem>啦啦啦啦啦啦啦啦啦啦啦啦</poem>',
].join('\n');

describe('syncVcpedia', () => {
  it('lists, fetches, parses and upserts; collects per-title errors', async () => {
    const fetchImpl = vi.fn(async (rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);
      if (url.includes('list=categorymembers')) {
        return jsonResponse({ query: { categorymembers: [{ title: '同步之歌' }, { title: '坏页面' }, { title: '空页面' }] } });
      }
      if (url.includes('titles=坏页面')) throw new Error('network down');
      if (url.includes('titles=空页面')) return jsonResponse({ query: { pages: {} } });
      if (url.includes('titles=同步之歌')) return jsonResponse(REVISION(SONG_PAGE));
      throw new Error(`unexpected ${url}`);
    });
    const upserted: string[] = [];
    const result = await syncVcpedia(
      { ...config, concurrency: 1 },
      async (detail) => { upserted.push(detail.name); return true; },
      fetchImpl as never,
    );
    expect(result.listed).toBe(3);
    expect(result.added).toEqual(['同步之歌']);
    expect(upserted).toEqual(['同步之歌']);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.title).toBe('坏页面');
    expect(result.skipped).toBe(1);
  });

  it('reports progress', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('list=categorymembers')) {
        return jsonResponse({ query: { categorymembers: [{ title: 'A' }] } });
      }
      return jsonResponse(REVISION(SONG_PAGE.replace('同步之歌', 'A')));
    });
    const seen: Array<[number, number]> = [];
    await syncVcpedia({ ...config, concurrency: 2 }, async () => true, fetchImpl as never, (done, total) => { seen.push([done, total]); });
    expect(seen.at(-1)).toEqual([1, 1]);
  });
});
