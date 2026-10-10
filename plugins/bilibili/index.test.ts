import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MohoMessage } from '../../src/core/types.js';
import plugin, { extractVideoRef, fetchVideo, formatDuration, formatVideo } from './index.js';

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

function context() {
  return { storage: { async get() { return undefined; }, async save() {}, async delete() {}, async query() { return []; } }, config: {} } as never;
}

describe('extractVideoRef', () => {
  it('finds full URLs, bare BV ids and av numbers', () => {
    expect(extractVideoRef('看看这个 https://www.bilibili.com/video/BV1xx411c7mD 很棒')).toEqual({ bvid: 'BV1xx411c7mD' });
    expect(extractVideoRef('https://m.bilibili.com/video/av170001?t=30')).toEqual({ aid: 170001 });
    expect(extractVideoRef('BV1xx411c7mD')).toEqual({ bvid: 'BV1xx411c7mD' });
    expect(extractVideoRef('av170001')).toEqual({ aid: 170001 });
  });

  it('ignores ordinary text', () => {
    expect(extractVideoRef('今天天气不错')).toBeNull();
    expect(extractVideoRef('BV太短')).toBeNull();
    expect(extractVideoRef('av12')).toBeNull();
  });
});

describe('formatDuration', () => {
  it('renders m:ss and h:mm:ss', () => {
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(-5)).toBe('0:00');
  });
});

describe('formatVideo', () => {
  it('renders title, author, duration and link', () => {
    const text = formatVideo({ bvid: 'BV1xx411c7mD', aid: 170001, title: '测试视频', author: 'UP主', durationSeconds: 125 });
    expect(text).toContain('测试视频');
    expect(text).toContain('UP主');
    expect(text).toContain('2:05');
    expect(text).toContain('https://www.bilibili.com/video/BV1xx411c7mD');
  });
});

describe('fetchVideo', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('parses the public view API response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ code: 0, data: { bvid: 'BV1xx411c7mD', aid: 170001, title: 'T', owner: { name: 'U' }, duration: 90 } }),
    })));
    const video = await fetchVideo({ bvid: 'BV1xx411c7mD' });
    expect(video).toMatchObject({ bvid: 'BV1xx411c7mD', title: 'T', author: 'U', durationSeconds: 90 });
  });

  it('returns null on API errors and network failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    expect(await fetchVideo({ bvid: 'BV1xx411c7mD' })).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    expect(await fetchVideo({ aid: 170001 })).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ code: -404, message: 'nope' }) })));
    expect(await fetchVideo({ bvid: 'BV1xx411c7mD' })).toBeNull();
  });
});

describe('bilibili plugin onMessage', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('replies with the video card and lets other messages through', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ code: 0, data: { bvid: 'BV1xx411c7mD', aid: 1, title: 'T', owner: { name: 'U' }, duration: 61 } }),
    })));
    const hit = await plugin.onMessage!(message('看这个 BV1xx411c7mD'), context());
    expect((hit as { reply: string }).reply).toContain('T');
    expect(await plugin.onMessage!(message('今天天气不错'), context())).toBeUndefined();
  });

  it('stays silent when the API is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    expect(await plugin.onMessage!(message('BV1xx411c7mD'), context())).toBeUndefined();
  });

  it('ignores bots', async () => {
    const bot = message('BV1xx411c7mD');
    bot.author.bot = true;
    expect(await plugin.onMessage!(bot, context())).toBeUndefined();
  });
});
