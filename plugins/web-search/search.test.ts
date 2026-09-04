import { describe, expect, it } from 'vitest';

import {
  buildSearxngUrl,
  formatResults,
  parseBrave,
  parseSearxng,
  parseTavily,
  search,
  type SearchConfig,
} from './search.js';

describe('buildSearxngUrl', () => {
  it('builds a JSON search URL with a count', () => {
    const url = buildSearxngUrl('https://searx.example/', 'hello world', 5);
    expect(url.startsWith('https://searx.example/search?')).toBe(true);
    expect(url).toContain('q=hello+world');
    expect(url).toContain('format=json');
    expect(url).toContain('count=5');
  });
});

describe('parsers', () => {
  it('parses searxng results', () => {
    const results = parseSearxng({
      results: [
        { title: 'A', url: 'https://a.example', content: 'first' },
        { title: 'B', url: 'https://b.example', snippet: 'second' },
        { url: '', title: 'no url' },
        null,
      ],
    });
    expect(results.map((r) => r.url)).toEqual(['https://a.example', 'https://b.example']);
  });

  it('parses brave results', () => {
    const results = parseBrave({
      web: { results: [{ title: 'A', url: 'https://a.example', description: 'desc' }] },
    });
    expect(results[0]?.snippet).toBe('desc');
  });

  it('parses tavily results', () => {
    const results = parseTavily({
      results: [{ title: 'A', url: 'https://a.example', content: 'body' }],
    });
    expect(results[0]?.snippet).toBe('body');
  });
});

describe('search', () => {
  const cfg: SearchConfig = { provider: 'searxng', baseUrl: 'https://searx.example', timeoutMs: 1000, maxResults: 3 };

  it('degrades to an empty list on failure', async () => {
    const fetchImpl = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    await expect(search(cfg, 'anything', fetchImpl)).resolves.toEqual([]);
  });

  it('returns parsed results on success', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      results: [{ title: 'T', url: 'https://t.example', content: 'snippet' }],
    }), { status: 200 })) as unknown as typeof fetch;
    const results = await search(cfg, 'hello', fetchImpl);
    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe('T');
  });
});

describe('formatResults', () => {
  it('formats and truncates', () => {
    const text = formatResults([{ title: 'T', url: 'https://t.example', snippet: 'x'.repeat(400) }]);
    expect(text).toContain('1. **T**');
    expect(text).toContain('https://t.example');
    expect(text.length).toBeLessThan(400);
  });

  it('reports empty', () => {
    expect(formatResults([])).toBe('没有找到相关结果。');
  });
});
