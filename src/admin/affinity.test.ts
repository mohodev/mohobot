import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AffinityStore } from './affinity.js';

let root: string;
const stores: AffinityStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe('AffinityStore', () => {
  it('clamps, persists, and reloads affinity scores', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mohobot-affinity-'));
    const first = new AffinityStore(root);
    const second = new AffinityStore(root);
    stores.push(first, second);

    await first.adjust('bot', 'user', 150, 'helpful', 'helped with setup');
    expect((await first.get('bot', 'user')).score).toBe(100);

    const row = await second.get('bot', 'user');
    expect(row.score).toBe(100);
    expect(row.notes).toEqual(['helped with setup']);
  });

  it('uses the shared runtime SQLite storage when supplied', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mohobot-affinity-shared-'));
    const { SqliteStorage } = await import('../storage/sqlite.js');
    const { createNullLogger } = await import('../core/logger.js');
    const storage = new SqliteStorage({ path: path.join(root, 'data', 'mohobot.db'), logger: createNullLogger() });
    await storage.init();
    const store = new AffinityStore(root, storage);
    await store.adjust('bot', 'user', 3, 'kind');
    expect(await storage.get('affinity:records')).toMatchObject([{ botId: 'bot', userId: 'user', score: 3 }]);
    await storage.close();
  });
});
