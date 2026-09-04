import { describe, expect, it } from 'vitest';

import { buildItunesUrl, formatTracks, parseItunes, searchItunes } from './itunes.js';

describe('buildItunesUrl', () => {
  it('builds a music song search URL', () => {
    const url = buildItunesUrl('bad romance', 3);
    expect(url.startsWith('https://itunes.apple.com/search?')).toBe(true);
    expect(url).toContain('term=bad+romance');
    expect(url).toContain('media=music');
    expect(url).toContain('entity=song');
    expect(url).toContain('limit=3');
  });
});

describe('parseItunes', () => {
  it('extracts track fields', () => {
    const tracks = parseItunes({
      resultCount: 1,
      results: [{
        trackName: 'Bad Romance',
        artistName: 'Lady Gaga',
        collectionName: 'The Fame Monster',
        previewUrl: 'https://preview.example.m4a',
        artworkUrl100: 'https://art.example.jpg',
        releaseDate: '2009-10-25T07:00:00Z',
        trackViewUrl: 'https://itunes.example/track',
      }, { wrapperType: 'collection', collectionName: 'no track' }, null],
    });
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({ title: 'Bad Romance', artist: 'Lady Gaga', releaseDate: '2009-10-25' });
  });
});

describe('searchItunes', () => {
  it('degrades to empty on failure', async () => {
    const fetchImpl = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
    await expect(searchItunes('x', 3, fetchImpl)).resolves.toEqual([]);
  });
});

describe('formatTracks', () => {
  it('renders title, artist and preview', () => {
    const text = formatTracks([{ title: 'T', artist: 'A', album: 'B', previewUrl: 'https://p.example' }]);
    expect(text).toContain('**T**');
    expect(text).toContain('A');
    expect(text).toContain('https://p.example');
  });
});
