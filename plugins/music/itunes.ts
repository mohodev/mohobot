/**
 * iTunes Search API client for the music plugin.
 *
 * Foreign replacement for the upstream NetEase Cloud Music plugin: the iTunes
 * Search API is free, needs no key, and returns track metadata + a playable
 * preview URL for almost any song worldwide.
 */

export interface Track {
  title: string;
  artist: string;
  album: string;
  /** 30-second streaming preview. */
  previewUrl?: string;
  artworkUrl?: string;
  releaseDate?: string;
  trackUrl?: string;
}

export function buildItunesUrl(term: string, limit: number, country = 'US'): string {
  const params = new URLSearchParams({
    term,
    media: 'music',
    entity: 'song',
    limit: String(limit),
    country,
  });
  return `https://itunes.apple.com/search?${params.toString()}`;
}

export function parseItunes(json: unknown): Track[] {
  const results = Array.isArray((json as { results?: unknown[] })?.results)
    ? ((json as { results: unknown[] }).results)
    : [];
  return results.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const row = item as Record<string, unknown>;
    const title = typeof row.trackName === 'string' ? row.trackName : '';
    if (!title) return [];
    return [{
      title,
      artist: typeof row.artistName === 'string' ? row.artistName : '未知艺术家',
      album: typeof row.collectionName === 'string' ? row.collectionName : '',
      previewUrl: typeof row.previewUrl === 'string' ? row.previewUrl : undefined,
      artworkUrl: typeof row.artworkUrl100 === 'string' ? row.artworkUrl100 : undefined,
      releaseDate: typeof row.releaseDate === 'string' ? row.releaseDate.slice(0, 10) : undefined,
      trackUrl: typeof row.trackViewUrl === 'string' ? row.trackViewUrl : undefined,
    }];
  });
}

export async function searchItunes(
  term: string,
  limit: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Track[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetchImpl(buildItunesUrl(term, limit), { signal: controller.signal });
      if (!response.ok) return [];
      const json = (await response.json()) as unknown;
      return parseItunes(json);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return [];
  }
}

export function formatTracks(tracks: Track[], limit = 3): string {
  if (tracks.length === 0) return '没有找到相关歌曲。';
  return tracks.slice(0, limit).map((t, i) => {
    const meta = [t.artist, t.album].filter(Boolean).join(' · ');
    const preview = t.previewUrl ?? t.trackUrl ?? '';
    return `${i + 1}. **${t.title}**\n${meta}${t.releaseDate ? `（${t.releaseDate}）` : ''}${preview ? `\n${preview}` : ''}`;
  }).join('\n\n');
}
