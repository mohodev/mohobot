import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AffinityStore } from './affinity.js';

let root: string;
afterEach(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });

describe('AffinityStore', () => {
  it('clamps, persists, and reloads affinity scores', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mohobot-affinity-'));
    const first = new AffinityStore(root);
    await first.adjust('bot', 'user', 150, 'helpful', 'helped with setup');
    expect((await first.get('bot', 'user')).score).toBe(100);
    const second = new AffinityStore(root);
    const row = await second.get('bot', 'user');
    expect(row.score).toBe(100);
    expect(row.notes).toEqual(['helped with setup']);
  });
});
