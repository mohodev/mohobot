import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorldStore } from './world.js';
import { DeviceStore } from './device.js';
import { AffinityStore } from './affinity.js';

const roots: string[] = [];
const stores: AffinityStore[] = [];

async function root(): Promise<string> {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), 'moho-stores-'));
  roots.push(value);
  return value;
}

function affinity(rootDir: string): AffinityStore {
  const store = new AffinityStore(rootDir);
  stores.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(roots.splice(0).map((value) => fs.rm(value, { recursive: true, force: true })));
});

describe('versioned admin stores compatibility', () => {
  it('imports legacy World into SQLite without modifying the JSON source', async () => {
    const r = await root();
    const file = path.join(r, 'data/world/state.json');
    const raw = JSON.stringify({ weather: 'rain', mood: { energy: 0.3 } });
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, raw);

    const state = await new WorldStore(r).get();
    expect(state.weather).toBe('rain');
    expect(state).not.toHaveProperty('format');
    expect(await fs.readFile(file, 'utf8')).toBe(raw);
  });

  it('migrates legacy Device and keeps defaults', async () => {
    const r = await root();
    const file = path.join(r, 'data/world/device.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ battery: 5, network: 'weak' }));

    const state = await new DeviceStore(r).get();
    expect(state).toMatchObject({ battery: 5, network: 'weak', screen: 'on' });
    expect(state).not.toHaveProperty('revision');
  });

  it('imports legacy Affinity JSON as read-only input and leaves the source untouched', async () => {
    const r = await root();
    const file = path.join(r, 'data/memory/affinity.json');
    const legacy = [{
      botId: 'b', userId: 'u', score: 4, interactions: 1,
      lastReason: 'kind', updatedAt: 'x', notes: [],
    }];
    const raw = JSON.stringify({ format: 'mohobot-json', version: 1, revision: 7, data: legacy });
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, raw);

    expect(await affinity(r).get('b', 'u')).toMatchObject({ score: 4 });
    expect(await fs.readFile(file, 'utf8')).toBe(raw);

    const { SqliteStorage } = await import('../storage/sqlite.js');
    const { createNullLogger } = await import('../core/logger.js');
    const storage = new SqliteStorage({ path: path.join(r, 'data/mohobot.db'), logger: createNullLogger() });
    await storage.init();
    expect(await storage.get('affinity:records')).toMatchObject([{ botId: 'b', userId: 'u', score: 4 }]);
    await storage.close();
  });

  it('does not lose concurrent affinity adjustments across instances', async () => {
    const r = await root();
    const a = affinity(r);
    const b = affinity(r);
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).adjust('bot', 'user', 1, 'helpful')));
    expect(await a.get('bot', 'user')).toMatchObject({ score: 20, interactions: 20 });
  });

  it('preserves corrupt World bytes instead of replacing defaults', async () => {
    const r = await root();
    const file = path.join(r, 'data/world/state.json');
    const raw = '{bad';
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, raw);

    await expect(new WorldStore(r).get()).rejects.toBeInstanceOf(SyntaxError);
    expect(await fs.readFile(file, 'utf8')).toBe(raw);
  });
});
