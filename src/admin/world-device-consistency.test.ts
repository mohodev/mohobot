import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorldStore } from './world.js';
import { DeviceStore } from './device.js';

const roots: string[] = [];
const worldStores: WorldStore[] = [];
const deviceStores: DeviceStore[] = [];

async function createRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'moho-consistency-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(worldStores.splice(0).map((store) => store.close()));
  await Promise.all(deviceStores.splice(0).map((store) => store.close()));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('World and Device cross-instance consistency', () => {
  it('reads the latest World state from SQLite and preserves concurrent event writes', async () => {
    const root = await createRoot();
    const a = new WorldStore(root);
    const b = new WorldStore(root);
    const reader = new WorldStore(root);
    worldStores.push(a, b, reader);

    await Promise.all([
      a.event('social', 'written by runtime A'),
      b.event('rest', 'written by runtime B'),
    ]);

    const state = await reader.get();
    expect(state.events.map((event) => event.text).sort()).toEqual([
      'written by runtime A',
      'written by runtime B',
    ]);
  });

  it('rejects saving a stale World snapshot instead of overwriting another runtime', async () => {
    const root = await createRoot();
    const a = new WorldStore(root);
    const b = new WorldStore(root);
    worldStores.push(a, b);

    const stale = await a.get();
    await b.event('social', 'new state');
    stale.location = 'stale location';

    await expect(a.save(stale)).rejects.toThrow(/stale snapshot/);
    expect((await a.get()).location).not.toBe('stale location');
  });

  it('merges concurrent Device transitions and returns fresh reads without a TTL delay', async () => {
    const root = await createRoot();
    const a = new DeviceStore(root);
    const b = new DeviceStore(root);
    const reader = new DeviceStore(root);
    deviceStores.push(a, b, reader);

    await Promise.all([
      a.transition({ network: 'offline' }),
      b.transition({ doNotDisturb: true }),
    ]);

    const state = await reader.get();
    expect(state.network).toBe('offline');
    expect(state.doNotDisturb).toBe(true);

    await a.transition({ network: 'wifi' });
    expect((await reader.get()).network).toBe('wifi');
  });

  it('rejects saving a stale Device snapshot instead of overwriting another runtime', async () => {
    const root = await createRoot();
    const a = new DeviceStore(root);
    const b = new DeviceStore(root);
    deviceStores.push(a, b);

    const stale = await a.get();
    await b.transition({ battery: 21 });
    stale.activity = 'gaming';

    await expect(a.save(stale)).rejects.toThrow(/stale snapshot/);
    expect((await a.get()).battery).toBe(21);
    expect((await a.get()).activity).not.toBe('gaming');
  });
});
