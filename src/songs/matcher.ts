/**
 * Song matcher: recognizes song mentions in chat and formats the injection.
 *
 * Port of upstream `mohobot/music_knowledge/matcher.py`. Three confidence
 * levels, first hit wins:
 *  1. 《歌名》 in book-title brackets -> direct lookup (highest confidence)
 *  2. bare text containing a song name (len >= threshold) plus a music
 *     context word (唱/听/歌/歌词/...) -> lookup (avoids everyday chatter)
 *  3. lyric fragments: 2-3 evenly sampled 12-20 char substrings of the
 *     longest text run matched against the in-memory (name, lyrics) index
 *
 * A hit formats a 【歌曲信息】 block (intro + credits + full lyrics) for
 * request-scoped injection: never written to context files, skipped silently
 * when the library is empty or nothing matches.
 */

import type { SongDetail } from './song.js';

/** Music context words: a bare song name only counts beside one of these. */
const SONG_CONTEXT_WORDS = [
  '歌', '唱', '听', '点', '循环', '安利', '作曲', '编曲', '调教', '歌词',
  '在放', '好喜欢', '首', '知道', '哪首', '来一首', '求歌名',
];

/** Leading request verbs stripped before bare-name matching. */
const PLAY_PREFIXES = [
  '帮我唱一首', '给我唱一首', '帮我唱个', '帮我唱', '唱一首', '点一首',
  '唱个', '来一首', '点个', '唱首', '来首',
];

const TRAILING_FILLERS = ['这首歌', '这首歌名', '这个歌曲'];

export interface MatchResult {
  /** 'title' | 'name' | 'lyrics' by confidence. */
  kind: 'title' | 'name' | 'lyrics';
  name: string;
}

export function stripPlayPrefix(text: string): string {
  let out = text.trim();
  for (const prefix of PLAY_PREFIXES) {
    if (out.startsWith(prefix)) {
      out = out.slice(prefix.length).trim();
      break;
    }
  }
  for (const trailing of TRAILING_FILLERS) {
    if (out.endsWith(trailing)) {
      out = out.slice(0, out.length - trailing.length).trim();
      break;
    }
  }
  return out;
}

function hasSongContext(text: string): boolean {
  return SONG_CONTEXT_WORDS.some((word) => text.includes(word));
}

/** Evenly sampled 12-20 char substrings of the longest text run. */
export function sampleLyricFragments(text: string, count = 3): string[] {
  const runs = text
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9，。！？、\s]/g, ' ')
    .split(/\s+/)
    .map((run) => run.trim())
    .filter((run) => run.length >= 12);
  if (runs.length === 0) return [];
  const longest = runs.reduce((a, b) => (a.length >= b.length ? a : b));
  const fragments: string[] = [];
  const size = Math.min(20, Math.max(12, Math.floor(longest.length / count)));
  for (let i = 0; i < count; i += 1) {
    const start = Math.floor((longest.length - size) * (count === 1 ? 0 : i / (count - 1)));
    const fragment = longest.slice(start, start + size);
    if (fragment.length >= 12) fragments.push(fragment);
  }
  return [...new Set(fragments)];
}

export interface SongIndexLike {
  name: string;
  lyrics: string;
}

/**
 * Matches chat text against the song index. `hasName` checks the canonical
 * name list (fast pre-filter); `getDetail` loads the full record on hit.
 */
export function matchSong(
  text: string,
  index: ReadonlyArray<SongIndexLike>,
  options: { minNameLength?: number } = {},
): MatchResult | null {
  if (index.length === 0 || !text.trim()) return null;
  const minNameLength = options.minNameLength ?? 3;

  // 1. 《title》 brackets: highest confidence, no context needed.
  const bracketed = text.match(/《([^《》]{1,40})》/);
  if (bracketed) {
    const name = bracketed[1]!.trim();
    if (index.some((entry) => entry.name === name)) return { kind: 'title', name };
  }

  const stripped = stripPlayPrefix(text);

  // 2. Bare song name + music context word.
  if (hasSongContext(stripped)) {
    const candidates = index
      .filter((entry) => entry.name.length >= minNameLength && stripped.includes(entry.name))
      .sort((a, b) => b.name.length - a.name.length);
    if (candidates[0]) return { kind: 'name', name: candidates[0].name };
  }

  // 3. Lyric fragments against the in-memory corpus.
  for (const fragment of sampleLyricFragments(stripped)) {
    const hit = index.find((entry) => entry.lyrics.includes(fragment));
    if (hit) return { kind: 'lyrics', name: hit.name };
  }
  return null;
}

const CREDIT_LABELS: Array<[keyof SongDetail, string]> = [
  ['singers', '演唱'],
  ['uploader', 'UP主'],
  ['lyricist', '作词'],
  ['composer', '作曲'],
  ['arranger', '编曲'],
  ['mixer', '混音'],
  ['tuner', '调教'],
  ['mastering', '母带'],
  ['pv', 'PV'],
  ['illustrator', '曲绘'],
  ['year', '年份'],
];

/** Formats the 【歌曲信息】 injection block for a matched song. */
export function formatSongBlock(detail: SongDetail): string {
  const lines = ['【歌曲信息】'];
  if (detail.introduction) lines.push(detail.introduction.slice(0, 500));
  const credits = CREDIT_LABELS
    .map(([field, label]) => {
      const value = detail[field];
      return value ? `${label}：${value}` : '';
    })
    .filter(Boolean);
  if (credits.length > 0) lines.push(credits.join(' / '));
  if (detail.bvid) lines.push(`BV号：${detail.bvid}`);
  lines.push(detail.lyrics);
  return lines.join('\n');
}

export type { SongDetail };
