/**
 * VCPedia wikitext parsing + song record model.
 *
 * Mirrors upstream `mohobot/music_knowledge/` (song_database.py schema,
 * vcpedia.py field extraction): a category page yields name, credits, bv id,
 * introduction and full lyrics from the standard Songbox templates. Pure
 * functions so the parser is unit-testable without any network.
 */

export interface SongDetail {
  name: string;
  uploader: string;
  singers: string;
  lyricist: string;
  composer: string;
  arranger: string;
  mixer: string;
  tuner: string;
  mastering: string;
  pv: string;
  illustrator: string;
  year?: number;
  introduction: string;
  lyrics: string;
  bvid?: string;
}

const MAX_LYRICS_CHARS = 8000;
const MAX_INTRO_CHARS = 1000;

/** Extracts a balanced `{{...}}` template starting at index (depth-aware). */
function extractTemplate(text: string, start: number): { body: string; end: number } | null {
  if (text.slice(start, start + 2) !== '{{') return null;
  let depth = 0;
  let i = start;
  while (i < text.length - 1) {
    if (text[i] === '{' && text[i + 1] === '{') { depth += 1; i += 2; continue; }
    if (text[i] === '}' && text[i + 1] === '}') {
      depth -= 1;
      i += 2;
      if (depth === 0) return { body: text.slice(start + 2, i - 2), end: i };
      continue;
    }
    i += 1;
  }
  return null;
}

/** Finds every top-level template whose name starts with one of the prefixes. */
function findTemplates(text: string, names: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length - 1) {
    if (text[i] === '{' && text[i + 1] === '{') {
      const found = extractTemplate(text, i);
      if (!found) { i += 2; continue; }
      const head = found.body.split('|')[0]?.trim() ?? '';
      if (names.some((name) => head === name || head.startsWith(`${name} `) || head.startsWith(`${name}\n`))) {
        out.push(found.body);
      }
      i = found.end;
      continue;
    }
    i += 1;
  }
  return out;
}

/** Parses `|key = value` lines; multi-role keys (`作曲<br>调校`) fan out. */
function parseTemplateFields(body: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const keys = line.slice(1, eq).split(/<br\s*\/?>/i).map((key) => key.trim()).filter(Boolean);
    const value = cleanInline(line.slice(eq + 1).trim());
    if (!value) continue;
    for (const key of keys) {
      const existing = fields.get(key);
      fields.set(key, existing ? `${existing}、${value}` : value);
    }
  }
  return fields;
}

/** `[[X]]` -> X, `[[X|Y]]` -> Y, `<br>` -> 、, stray tags dropped. */
export function cleanInline(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, '、')
    .replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/'{2,}/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[、，,；;]+$/u, '');
}

function pick(fields: Map<string, string>, ...names: string[]): string {
  for (const name of names) {
    const value = fields.get(name);
    if (value) return value;
  }
  return '';
}

/** Cleans the `<poem>` lyrics body: templates, refs, tags and wiki italics. */
export function cleanLyrics(raw: string): string {
  let text = raw;
  // Balanced templates first (lyrics may sit inside {{color|...|...}}).
  let guard = 0;
  while (text.includes('{{') && guard < 50) {
    guard += 1;
    const start = text.indexOf('{{');
    const found = extractTemplate(text, start);
    if (!found) break;
    // Keep the last pipe segment when it holds lyric text, else drop all.
    const segments = found.body.split('|');
    const tail = segments.length > 1 ? (segments[segments.length - 1] ?? '') : '';
    const keep = /[\u4e00-\u9fa5a-zA-Z]{4,}/.test(tail) ? tail : '';
    text = text.slice(0, start) + keep + text.slice(found.end);
  }
  text = text.replace(/<ref[\s>][\s\S]*?<\/ref>/gi, '').replace(/<ref[^/]*\/>/gi, '');
  text = text.replace(/<\/?poem[^>]*>/gi, '').replace(/<[^>]+>/g, '');
  text = text.replace(/''+/g, '');
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  return lines.join('\n').slice(0, MAX_LYRICS_CHARS);
}

/** Parses one category page's wikitext into a song record, or null to skip. */
export function parseSongPage(title: string, wikitext: string): SongDetail | null {
  if (!wikitext || !wikitext.trim()) return null;
  const songboxes = findTemplates(wikitext, ['VOCALOID_Songbox']);
  const intros = findTemplates(wikitext, ['VOCALOID Songbox Introduction']);
  const fields = new Map<string, string>();
  for (const body of [...songboxes, ...intros]) {
    for (const [key, value] of parseTemplateFields(body)) {
      if (!fields.has(key)) fields.set(key, value);
    }
  }

  const bvidMatch = wikitext.match(/\{\{\s*BilibiliVideo\s*\|\s*id\s*=\s*(BV[a-zA-Z0-9]{10})/);
  const bvid = bvidMatch?.[1] ?? pick(fields, 'bb_id', 'bv号', 'BV号').match(/BV[a-zA-Z0-9]{10}/)?.[0];

  // Lyrics: the == 歌词 == section's <poem> body.
  const lyricSection = wikitext.split(/^==\s*歌词\s*==/m)[1]?.split(/^==[^=]/m)[0] ?? '';
  const poem = lyricSection.match(/<poem[^>]*>([\s\S]*?)<\/poem>/i)?.[1] ?? '';
  const lyrics = cleanLyrics(poem);

  const name = pick(fields, '歌曲名称', '歌名', '标题') || title.trim();
  if (!name || !lyrics) return null;

  // Introduction: prose between the templates and the lyrics section.
  const beforeLyrics = wikitext.split(/^==\s*歌词\s*==/m)[0] ?? '';
  const intro = cleanInline(stripTemplates(beforeLyrics)).slice(0, MAX_INTRO_CHARS);

  const yearMatch = wikitext.match(/\|\s*年份\s*=\s*(\d{4})/)
    ?? wikitext.match(/\{\{\s*洛天依\/(\d{4})/)
    ?? beforeLyrics.match(/(\d{4})\s*年/);
  const year = yearMatch ? Number.parseInt(yearMatch[1]!, 10) : undefined;

  return {
    name,
    uploader: pick(fields, 'UP主', 'up主', '投稿'),
    singers: pick(fields, '演唱', '歌手'),
    lyricist: pick(fields, '作词'),
    composer: pick(fields, '作曲'),
    arranger: pick(fields, '编曲'),
    mixer: pick(fields, '混音'),
    tuner: pick(fields, '调校', '调教'),
    mastering: pick(fields, '母带'),
    pv: pick(fields, 'PV', 'pv'),
    illustrator: pick(fields, '曲绘', '插画', '封面'),
    ...(year !== undefined && year >= 1900 && year <= 2100 ? { year } : {}),
    introduction: intro,
    lyrics,
    ...(bvid ? { bvid } : {}),
  };
}

/** Removes all balanced templates (best effort, depth-aware). */
function stripTemplates(text: string): string {
  let out = text;
  let guard = 0;
  while (out.includes('{{') && guard < 200) {
    guard += 1;
    const start = out.indexOf('{{');
    const found = extractTemplate(out, start);
    if (!found) break;
    out = out.slice(0, start) + ' ' + out.slice(found.end);
  }
  return out
    .replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/^==.*==$/gm, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+\n/g, '\n');
}
