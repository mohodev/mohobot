import { describe, expect, it } from 'vitest';

import { supportsClientReady } from './client.js';

describe('discord.js ready-event version gate', () => {
  it('uses clientReady on versions that emit it', () => {
    expect(supportsClientReady('14.27.0')).toBe(true);
    expect(supportsClientReady('14.16.0')).toBe(true);
    expect(supportsClientReady('14.16.3')).toBe(true);
    expect(supportsClientReady('15.0.0')).toBe(true);
    expect(supportsClientReady('15')).toBe(true);
  });

  it('falls back to the legacy ready name on older versions', () => {
    expect(supportsClientReady('14.15.2')).toBe(false);
    expect(supportsClientReady('14.9.0')).toBe(false);
    expect(supportsClientReady('13.14.2')).toBe(false);
  });

  it('treats unparseable versions as legacy (safe: ready always existed)', () => {
    expect(supportsClientReady('')).toBe(false);
    expect(supportsClientReady('nightly')).toBe(false);
  });
});
