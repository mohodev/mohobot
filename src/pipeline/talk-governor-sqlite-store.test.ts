import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNullLogger } from '../core/logger.js';
import { SqliteStorage } from '../storage/sqlite.js';
import type { Storage } from '../storage/types.js';
import { SqliteTalkGovernorStateStore } from './talk-governor-sqlite-store.js';
import type { TalkGovernorChannelState } from './talk-governor-state.js';

function fresh(): TalkGovernorChannelState {
  return { delivered: [], lastAt: 0, consecutive: 0, backoffUntil: 0, focusUntil: 0, pending: new Map() };
}

describe('SqliteTalkGovernorStateStore', () => {
  let storage: Storage;
  let store: SqliteTalkGovernorStateStore;

  beforeEach(async () => {
    storage = new SqliteStorage({ path: ':memory:', logger: createNullLogger() });
    await storage.init();
    store = new SqliteTalkGovernorStateStore(storage);
    await store.init();
  });

  afterEach(async () => {
    await storage.close();
  });

  it('returns undefined for unknown channels', () => {
    expect(store.get('unknown')).toBeUndefined();
  });

  it('set then get round-trips channel state', () => {
    const state: TalkGovernorChannelState = {
      delivered: [1000, 2000],
      lastAt: 2000,
      consecutive: 2,
      backoffUntil: 5000,
      focusUntil: 0,
      pending: new Map(),
    };
    store.set('ch1', state);
    const retrieved = store.get('ch1');
    expect(retrieved).toBeDefined();
    expect(retrieved!.delivered).toEqual([1000, 2000]);
    expect(retrieved!.lastAt).toBe(2000);
    expect(retrieved!.consecutive).toBe(2);
    expect(retrieved!.backoffUntil).toBe(5000);
  });

  it('delete removes a single channel', () => {
    store.set('ch1', fresh());
    store.set('ch2', fresh());
    store.delete('ch1');
    expect(store.get('ch1')).toBeUndefined();
    expect(store.get('ch2')).toBeDefined();
  });

  it('delete without channelId clears all', () => {
    store.set('ch1', fresh());
    store.set('ch2', fresh());
    store.delete();
    expect(store.get('ch1')).toBeUndefined();
    expect(store.get('ch2')).toBeUndefined();
  });

  it('persists state to SQLite and restores on init', async () => {
    const state: TalkGovernorChannelState = {
      delivered: [100, 200, 300],
      lastAt: 300,
      consecutive: 3,
      backoffUntil: 900,
      focusUntil: 500,
      pending: new Map([['msg1', 42]]),
    };
    store.set('ch1', state);
    await store.flush();

    const store2 = new SqliteTalkGovernorStateStore(storage);
    await store2.init();
    const restored = store2.get('ch1');
    expect(restored).toBeDefined();
    expect(restored!.delivered).toEqual([100, 200, 300]);
    expect(restored!.lastAt).toBe(300);
    expect(restored!.consecutive).toBe(3);
    expect(restored!.backoffUntil).toBe(900);
    expect(restored!.focusUntil).toBe(500);
    expect(restored!.pending).toBeInstanceOf(Map);
    expect(restored!.pending.get('msg1')).toBe(42);
  });

  it('overwrites previous state idempotently', async () => {
    store.set('ch1', { ...fresh(), lastAt: 100 });
    store.set('ch1', { ...fresh(), lastAt: 200 });
    await store.flush();

    const store2 = new SqliteTalkGovernorStateStore(storage);
    await store2.init();
    expect(store2.get('ch1')!.lastAt).toBe(200);
  });

  it('handles multiple channels independently', async () => {
    store.set('ch1', { ...fresh(), consecutive: 1 });
    store.set('ch2', { ...fresh(), consecutive: 2 });
    store.set('ch3', { ...fresh(), consecutive: 3 });
    await store.flush();

    const store2 = new SqliteTalkGovernorStateStore(storage);
    await store2.init();
    expect(store2.get('ch1')!.consecutive).toBe(1);
    expect(store2.get('ch2')!.consecutive).toBe(2);
    expect(store2.get('ch3')!.consecutive).toBe(3);
  });

  it('delete persists removal to SQLite', async () => {
    store.set('ch1', fresh());
    await store.flush();
    store.delete('ch1');

    const store2 = new SqliteTalkGovernorStateStore(storage);
    await store2.init();
    expect(store2.get('ch1')).toBeUndefined();
  });
});
