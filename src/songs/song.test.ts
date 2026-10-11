import { describe, expect, it } from 'vitest';

import { cleanInline, cleanLyrics, parseSongPage } from './song.js';

const PAGE = [
  '{{VOCALOID_Songbox',
  '|image    = 测试.jpg',
  '|颜色1    = linear-gradient(20deg,#daecf0,#c9e5e9)',
  '|演唱     = [[洛天依]]',
  '|歌曲名称 = 测试之歌',
  '|UP主     = [[测试UP]]',
  '|bb_id    = BV1xx411c7mD',
  '}}',
  '',
  '{{BilibiliVideo|id=BV1xx411c7mD}}',
  '',
  '== 歌词 ==',
  '{{VOCALOID Songbox Introduction',
  '|作曲<br>编曲 = [[作曲人]]',
  '|作词 = [[作词人]]',
  '|演唱 = [[洛天依]]',
  '}}',
  '<poem>',
  "{{color|#fff|",
  '第一句歌词在此',
  '第二句歌词在此处很长很长',
  "}}<ref>某注释</ref>",
  "''斜体''普通行",
  '</poem>',
  '',
  '{{洛天依/2023|collapsed|nocate=1}}',
  '[[Category:洛天依歌曲]]',
].join('\n');

describe('parseSongPage', () => {
  it('extracts credits, bvid, year and clean lyrics', () => {
    const song = parseSongPage('测试之歌', PAGE);
    expect(song).not.toBeNull();
    expect(song).toMatchObject({
      name: '测试之歌',
      uploader: '测试UP',
      singers: '洛天依',
      lyricist: '作词人',
      composer: '作曲人',
      arranger: '作曲人',
      illustrator: '',
      year: 2023,
      bvid: 'BV1xx411c7mD',
    });
    expect(song!.lyrics).toContain('第一句歌词在此');
    expect(song!.lyrics).toContain('第二句歌词在此处很长很长');
    expect(song!.lyrics).not.toContain('color');
    expect(song!.lyrics).not.toContain('某注释');
    expect(song!.lyrics).not.toContain("''");
    expect(song!.lyrics).not.toContain('Category');
  });

  it('falls back to the page title and skips lyric-less pages', () => {
    const noTitle = parseSongPage('备用标题', PAGE.replace('|歌曲名称 = 测试之歌', ''));
    expect(noTitle?.name).toBe('备用标题');
    expect(parseSongPage('空页面', '只有介绍没有歌词')).toBeNull();
    expect(parseSongPage('x', '')).toBeNull();
  });

  it('reads bvid from the songbox when no BilibiliVideo template exists', () => {
    const song = parseSongPage('T', '{{VOCALOID_Songbox\n|歌曲名称 = T\n|bb_id = BV1ab2cd3ef4\n}}\n== 歌词 ==\n<poem>啦啦啦啦啦啦啦啦啦啦啦啦</poem>');
    expect(song?.bvid).toBe('BV1ab2cd3ef4');
  });
});

describe('cleanInline', () => {
  it('resolves links, breaks and tags', () => {
    expect(cleanInline('[[洛天依]]')).toBe('洛天依');
    expect(cleanInline('[[星葵|星葵P]]')).toBe('星葵P');
    expect(cleanInline('AX-寂川<br>[[星葵]]')).toBe('AX-寂川、星葵');
    expect(cleanInline("'''加粗'''")).toBe('加粗');
  });
});

describe('cleanLyrics', () => {
  it('keeps lyric lines and drops markup', () => {
    const out = cleanLyrics("{{color|#fff|\n保留这句\n}}\n<ref>注</ref>\n\n''斜体''\n<p>tag</p>");
    expect(out).toContain('保留这句');
    expect(out).not.toContain('color');
    expect(out).not.toContain('<');
  });
});
