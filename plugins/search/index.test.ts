import { describe, expect, it, vi } from 'vitest';

import type { MohoMessage } from '../../src/core/types.js';
import plugin, {
  formatResults,
  parseAnysearchMarkdown,
  parseDuckDuckGoHtml,
  parseSearchCommand,
} from './index.js';

function message(content: string): MohoMessage {
  return {
    id: 'm1',
    platform: 'discord',
    botId: 'main',
    channel: { id: 'c1', dm: false },
    author: { id: 'u1', username: 'user', bot: false },
    content,
    mentionsBot: false,
    attachments: [],
    createdAt: 1,
  };
}

function context(config: Record<string, unknown> = {}) {
  return { storage: { async get() { return undefined; }, async save() {}, async delete() {}, async query() { return []; } }, config } as never;
}

const ANYSEARCH_SAMPLE = [
  '## Search Results (2 results, 500ms)',
  '',
  '### 1. Example Song - Singer',
  '- **URL**: https://example.com/song',
  '- A famous song by a virtual singer',
  '- Released in 2020',
  '### 2. Another Page',
  '- **URL**: https://example.com/other',
  '- Something else entirely',
].join('\n');

const DDG_HTML_SAMPLE = [
  '<div class="result results_links results_links_deep web-result ">',
  '<h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fsong&amp;rut=abc">Example <b>Song</b></a></h2>',
  '<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fsong&amp;rut=abc">A famous song snippet here</a>',
  '</div>',
  '<div class="result results_links results_links_deep web-result ">',
  '<h2 class="result__title"><a rel="nofollow" class="result__a" href="https://example.com/plain">Plain Link</a></h2>',
  '</div>',
].join('\n');

describe('parseSearchCommand', () => {
  it('accepts 搜索 and /搜索 with content, usage hint when bare', () => {
    expect(parseSearchCommand('搜索 洛天依 新歌')).toBe('洛天依 新歌');
    expect(parseSearchCommand('/搜索 洛天依')).toBe('洛天依');
    expect(parseSearchCommand('搜索：言和')).toBe('言和');
    expect(parseSearchCommand('搜索')).toBe('');
    expect(parseSearchCommand('/搜索')).toBe('');
  });

  it('ignores ordinary chat', () => {
    expect(parseSearchCommand('今天天气不错')).toBeNull();
    expect(parseSearchCommand('搜索一下我的人生')).toBeNull();
    expect(parseSearchCommand('')).toBeNull();
  });
});

describe('parseAnysearchMarkdown', () => {
  it('reads title, url and bullets', () => {
    const results = parseAnysearchMarkdown(ANYSEARCH_SAMPLE, 5);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ title: 'Example Song - Singer', url: 'https://example.com/song', source: 'anysearch' });
    expect(results[0]!.snippet).toContain('famous song');
    expect(results[1]).toMatchObject({ title: 'Another Page', url: 'https://example.com/other' });
  });

  it('caps at the limit and skips title-less blocks', () => {
    expect(parseAnysearchMarkdown(ANYSEARCH_SAMPLE, 1)).toHaveLength(1);
    expect(parseAnysearchMarkdown('### 1. \n- **URL**: https://x.com/\n', 5)).toHaveLength(0);
    expect(parseAnysearchMarkdown('not markdown', 5)).toHaveLength(0);
  });
});

describe('parseDuckDuckGoHtml', () => {
  it('unwraps uddg links and strips tags', () => {
    const results = parseDuckDuckGoHtml(DDG_HTML_SAMPLE);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ title: 'Example Song', url: 'https://example.com/song', source: 'duckduckgo' });
    expect(results[0]!.snippet).toContain('famous song snippet');
    expect(results[1]).toMatchObject({ title: 'Plain Link', url: 'https://example.com/plain' });
  });

  it('degrades on challenge pages and junk', () => {
    expect(parseDuckDuckGoHtml('<html>anomaly-modal challenge</html>')).toHaveLength(0);
    expect(parseDuckDuckGoHtml('')).toHaveLength(0);
  });
});

describe('formatResults', () => {
  it('numbers results with source icon', () => {
    const text = formatResults('洛天依', [
      { title: 'A', snippet: 'sa', url: 'https://a.com/', source: 'anysearch' },
      { title: 'B', snippet: '', url: '', source: 'wikipedia' },
    ]);
    expect(text).toContain('🔍 搜索：洛天依');
    expect(text).toContain('1. A');
    expect(text).toContain('2. B');
  });
});

describe('search plugin onMessage', () => {
  it('answers from the first succeeding backend', async () => {
    // Stub fetch: anysearch succeeds immediately.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('anysearch')) {
        return { ok: true, json: async () => ({ result: { content: [{ type: 'text', text: ANYSEARCH_SAMPLE }] } }) };
      }
      throw new Error('must not be called');
    }));
    try {
      const hit = await plugin.onMessage!(message('搜索 测试歌曲'), context());
      expect((hit as { reply: string }).reply).toContain('Example Song - Singer');
      expect(hit).toMatchObject({ stop: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls through backends to wikipedia when earlier ones fail', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const target = String(url);
      if (target.includes('anysearch')) throw new Error('down');
      if (target.includes('duckduckgo')) throw new Error('down');
      if (target.includes('opensearch')) {
        return { ok: true, text: async () => JSON.stringify(['洛天依', ['洛天依'], ['desc'], ['https://zh.wikipedia.org/wiki/x']]) };
      }
      if (target.includes('rest_v1')) {
        return { ok: true, text: async () => JSON.stringify({ title: '洛天依', description: '虚拟歌手', extract: '简介', content_urls: { desktop: { page: 'https://zh.wikipedia.org/wiki/x' } } }) };
      }
      throw new Error('unexpected ' + target);
    }));
    try {
      const hit = await plugin.onMessage!(message('搜索 洛天依'), context());
      expect((hit as { reply: string }).reply).toContain('洛天依');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('says so on explicit empty results, stays silent on total outage', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const target = String(url);
      if (target.includes('anysearch')) {
        return { ok: true, json: async () => ({ result: { content: [{ type: 'text', text: 'no results here' }] } }) };
      }
      throw new Error('down');
    }));
    try {
      const empty = await plugin.onMessage!(message('搜索 冷僻词xyz'), context());
      expect((empty as { reply: string }).reply).toContain('没搜到');
    } finally {
      vi.unstubAllGlobals();
    }

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('all down'); }));
    try {
      expect(await plugin.onMessage!(message('搜索 xxx'), context())).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('shows usage on bare 搜索 and ignores bots and chatter', async () => {
    const hint = await plugin.onMessage!(message('搜索'), context());
    expect((hint as { reply: string }).reply).toContain('用法');
    const bot = message('搜索 xxx');
    bot.author.bot = true;
    expect(await plugin.onMessage!(bot, context())).toBeUndefined();
    expect(await plugin.onMessage!(message('今天天气不错'), context())).toBeUndefined();
  });
});
