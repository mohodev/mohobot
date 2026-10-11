import { describe, expect, it } from 'vitest';

import { formatSongBlock, matchSong, sampleLyricFragments, stripPlayPrefix } from './matcher.js';
import type { SongDetail } from './song.js';

const INDEX = [
  { name: '达拉崩吧', lyrics: '很久很久以前巨龙突然出现带来灾难国王 evident' },
  { name: '普通DISCO', lyrics: '在20aa年的一个夜晚之后就再也没有回来过' },
  { name: '歌', lyrics: '短名测试歌词内容填充足够长' },
];

function detail(name: string): SongDetail {
  return {
    name, uploader: 'UP主', singers: '洛天依', lyricist: '', composer: '',
    arranger: '', mixer: '', tuner: '', mastering: '', pv: '', illustrator: '',
    introduction: '介绍', lyrics: '啦啦歌词', bvid: 'BV1xx411c7mD',
  };
}

describe('stripPlayPrefix', () => {
  it('removes request verbs and trailing fillers', () => {
    expect(stripPlayPrefix('来一首达拉崩吧')).toBe('达拉崩吧');
    expect(stripPlayPrefix('唱一首达拉崩吧这首歌')).toBe('达拉崩吧');
    expect(stripPlayPrefix('达拉崩吧')).toBe('达拉崩吧');
  });
});

describe('matchSong', () => {
  it('matches 《title》 brackets with top confidence and no context needed', () => {
    expect(matchSong('去听《达拉崩吧》吧', INDEX)).toEqual({ kind: 'title', name: '达拉崩吧' });
    expect(matchSong('《不存在的歌》好听吗', INDEX)).toBeNull();
  });

  it('matches bare names only beside a music context word', () => {
    expect(matchSong('循环达拉崩吧一整天', INDEX)).toEqual({ kind: 'name', name: '达拉崩吧' });
    // No context word: everyday chatter stays unmatched.
    expect(matchSong('达拉崩吧是谁', INDEX)).toBeNull();
    // Short names need the length gate... but context still applies first.
    expect(matchSong('这首歌真不错', INDEX)).toBeNull();
  });

  it('matches lyric fragments against the corpus', () => {
    expect(matchSong('巨龙突然出现带来灾难国王', INDEX)).toEqual({ kind: 'lyrics', name: '达拉崩吧' });
    expect(matchSong('今天天气真不错啊哈哈哈', INDEX)).toBeNull();
  });

  it('returns null on empty input or empty index', () => {
    expect(matchSong('', INDEX)).toBeNull();
    expect(matchSong('《达拉崩吧》', [])).toBeNull();
    expect(matchSong('   ', INDEX)).toBeNull();
  });
});

describe('sampleLyricFragments', () => {
  it('samples even 12-20 char windows', () => {
    const fragments = sampleLyricFragments('巨龙突然出现带来灾难国王降临');
    expect(fragments.length).toBeGreaterThan(0);
    for (const fragment of fragments) expect(fragment.length).toBeGreaterThanOrEqual(12);
    expect(sampleLyricFragments('太短')).toEqual([]);
  });
});

describe('formatSongBlock', () => {
  it('renders intro, credits and lyrics', () => {
    const block = formatSongBlock(detail('达拉崩吧'));
    expect(block.startsWith('【歌曲信息】')).toBe(true);
    expect(block).toContain('介绍');
    expect(block).toContain('演唱：洛天依');
    expect(block).toContain('BV号：BV1xx411c7mD');
    expect(block).toContain('啦啦歌词');
  });

  it('skips empty credit fields', () => {
    const block = formatSongBlock(detail('X'));
    expect(block).not.toContain('作词');
    expect(block).not.toContain('母带');
  });
});
