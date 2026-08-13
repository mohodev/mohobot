import { describe, expect, it } from 'vitest';

import { SessionConfigSchema, type SessionConfig } from '../config/schema.js';
import { createNullLogger } from '../core/logger.js';
import type { ChatMessage } from '../core/types.js';
import type { MemoryAdapter, QueryFilter, Storage, StoredRecord } from '../storage/types.js';
import { SessionManager } from './manager.js';

const logger = createNullLogger();
const input = { botId: 'bot1', channelId: 'chan1', userId: 'user1' };

function config(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return SessionConfigSchema.parse({ persist: false, ...overrides });
}

function user(content: string): ChatMessage {
  return { role: 'user', content };
}

/** Minimal Map-backed Storage used only by these tests. */
function fakeStorage(): Storage & { data: Map<string, unknown>; saves: number } {
  const data = new Map<string, unknown>();
  const store = {
    data,
    saves: 0,
    async init(): Promise<void> {},
    async save<T>(key: string, value: T): Promise<void> {
      store.saves += 1;
      data.set(key, JSON.parse(JSON.stringify(value)) as unknown);
    },
    async get<T>(key: string): Promise<T | undefined> {
      return data.get(key) as T | undefined;
    },
    async delete(key: string): Promise<void> {
      data.delete(key);
    },
    async query<T>(_filter: QueryFilter): Promise<StoredRecord<T>[]> {
      return [];
    },
    async purgeExpired(): Promise<number> {
      return 0;
    },
    async close(): Promise<void> {},
  };
  return store;
}

/** Storage where every operation blows up. */
function brokenStorage(): Storage {
  const boom = async (): Promise<never> => {
    throw new Error('storage is on fire');
  };
  return {
    init: boom,
    save: boom,
    get: boom,
    delete: boom,
    query: boom,
    purgeExpired: boom,
    close: boom,
  } as unknown as Storage;
}

describe('SessionManager keys', () => {
  it('scopes per user by default', async () => {
    const mgr = new SessionManager({ botId: 'bot1', config: config({ scope: 'user' }), logger });
    const session = await mgr.get(input);
    expect(session.key).toBe('session:bot1:chan1:user1');
    expect(session.userId).toBe('user1');
  });

  it('shares one session per channel in channel scope', async () => {
    const mgr = new SessionManager({ botId: 'bot1', config: config({ scope: 'channel' }), logger });
    const a = await mgr.get(input);
    const b = await mgr.get({ ...input, userId: 'someone-else' });

    expect(a.key).toBe('session:bot1:chan1');
    expect(b.key).toBe(a.key);
    expect(a.userId).toBeUndefined();
    expect(mgr.size()).toBe(1);
  });

  it('keeps different users apart in user scope', async () => {
    const mgr = new SessionManager({ botId: 'bot1', config: config({ scope: 'user' }), logger });
    await mgr.get(input);
    await mgr.get({ ...input, userId: 'user2' });
    expect(mgr.size()).toBe(2);
  });
});

describe('SessionManager trimming', () => {
  it('drops the oldest turns beyond maxMessages', async () => {
    const mgr = new SessionManager({ botId: 'bot1', config: config({ maxMessages: 3 }), logger });
    for (const text of ['one', 'two', 'three', 'four', 'five']) {
      await mgr.append(input, user(text));
    }
    const session = await mgr.get(input);
    expect(session.messages.map((m) => m.content)).toEqual(['three', 'four', 'five']);
  });

  it('drops from the front until the char budget fits', async () => {
    const mgr = new SessionManager({ botId: 'bot1', config: config({ maxMessages: 50, maxChars: 25 }), logger });
    await mgr.append(input, user('a'.repeat(10)));
    await mgr.append(input, user('b'.repeat(10)));
    await mgr.append(input, user('c'.repeat(10)));

    const session = await mgr.get(input);
    const total = session.messages.reduce((n, m) => n + m.content.length, 0);
    expect(total).toBeLessThanOrEqual(25);
    expect(session.messages).toHaveLength(2);
    expect(session.messages[0]?.content).toBe('b'.repeat(10));
  });

  it('keeps but truncates a single oversized newest turn', async () => {
    const mgr = new SessionManager({ botId: 'bot1', config: config({ maxChars: 20 }), logger });
    await mgr.append(input, user('old message'));
    await mgr.append(input, user('z'.repeat(100)));

    const session = await mgr.get(input);
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]?.content).toBe('z'.repeat(20));
  });
});

describe('SessionManager buildContext', () => {
  it('puts the system prompt first, then memory, then history', async () => {
    const memory: MemoryAdapter = {
      name: 'test-memory',
      async recall() {
        return [{ role: 'assistant', content: 'recalled fact' }];
      },
      async remember() {},
    };
    const mgr = new SessionManager({ botId: 'bot1', config: config(), logger, memory });
    await mgr.append(input, user('hello'));

    const ctx = await mgr.buildContext(input, 'SYSTEM PROMPT');
    expect(ctx).toHaveLength(3);
    expect(ctx[0]).toEqual({ role: 'system', content: 'SYSTEM PROMPT' });
    expect(ctx[1]?.content).toBe('recalled fact');
    expect(ctx[2]?.content).toBe('hello');
  });

  it('survives a memory adapter that throws', async () => {
    const memory: MemoryAdapter = {
      name: 'broken-memory',
      async recall(): Promise<ChatMessage[]> {
        throw new Error('vector db down');
      },
      async remember() {},
    };
    const mgr = new SessionManager({ botId: 'bot1', config: config(), logger, memory });
    await mgr.append(input, user('hello'));

    const ctx = await mgr.buildContext(input, 'SYS');
    expect(ctx.map((m) => m.content)).toEqual(['SYS', 'hello']);
  });
});

describe('SessionManager persistence', () => {
  it('round-trips a session through storage', async () => {
    const storage = fakeStorage();
    const cfg = config({ persist: true });

    const first = new SessionManager({ botId: 'bot1', config: cfg, logger, storage });
    await first.append(input, user('remember me'));
    await first.append(input, { role: 'assistant', content: 'noted' });
    await first.flush();

    expect(storage.data.has('session:bot1:chan1:user1')).toBe(true);

    const second = new SessionManager({ botId: 'bot1', config: cfg, logger, storage });
    const restored = await second.get(input);
    expect(restored.messages.map((m) => m.content)).toEqual(['remember me', 'noted']);
    expect(restored.key).toBe('session:bot1:chan1:user1');
  });

  it('serializes writes so a slow older save cannot overwrite newer context', async () => {
    const data = new Map<string, unknown>();
    let releaseFirst: (() => void) | undefined;
    let saves = 0;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const storage: Storage = {
      async init() {},
      async save<T>(key: string, value: T) {
        saves += 1;
        if (saves === 1) await firstBlocked;
        data.set(key, JSON.parse(JSON.stringify(value)) as unknown);
      },
      async get<T>(key: string) { return data.get(key) as T | undefined; },
      async delete(key: string) { data.delete(key); },
      async query<T>(_filter: QueryFilter): Promise<StoredRecord<T>[]> { return []; },
      async purgeExpired() { return 0; },
      async close() {},
    };
    const mgr = new SessionManager({ botId: 'bot1', config: config({ persist: true }), logger, storage });

    await mgr.append(input, user('first'));
    await mgr.append(input, user('second'));
    expect(saves).toBe(1);
    releaseFirst?.();
    await mgr.flush();

    const saved = data.get('session:bot1:chan1:user1') as { messages: ChatMessage[] };
    expect(saved.messages.map((m) => m.content)).toEqual(['first', 'second']);
  });

  it('does not touch storage when persist is false', async () => {
    const storage = fakeStorage();
    const mgr = new SessionManager({ botId: 'bot1', config: config({ persist: false }), logger, storage });
    await mgr.append(input, user('nope'));
    await mgr.flush();
    expect(storage.saves).toBe(0);
    expect(storage.data.size).toBe(0);
  });

  it('clear() removes the session from cache and storage', async () => {
    const storage = fakeStorage();
    const mgr = new SessionManager({ botId: 'bot1', config: config({ persist: true }), logger, storage });
    await mgr.append(input, user('bye'));
    await mgr.flush();

    await mgr.clear(input);
    await mgr.flush();

    expect(mgr.size()).toBe(0);
    expect(storage.data.size).toBe(0);
    const fresh = await mgr.get(input);
    expect(fresh.messages).toEqual([]);
  });

  it('a throwing storage never breaks append, get or clear', async () => {
    const mgr = new SessionManager({
      botId: 'bot1',
      config: config({ persist: true }),
      logger,
      storage: brokenStorage(),
    });

    await expect(mgr.append(input, user('still works'))).resolves.toBeUndefined();
    await expect(mgr.flush()).resolves.toBeUndefined();

    const session = await mgr.get(input);
    expect(session.messages.map((m) => m.content)).toEqual(['still works']);

    await expect(mgr.clear(input)).resolves.toBeUndefined();
    await expect(mgr.flush()).resolves.toBeUndefined();
  });
});

describe('SessionManager sweep', () => {
  it('removes sessions idle longer than the ttl', async () => {
    const mgr = new SessionManager({ botId: 'bot1', config: config({ ttlSeconds: 60 }), logger });

    const stale = await mgr.get(input);
    stale.updatedAt = Date.now() - 120_000;
    await mgr.get({ ...input, userId: 'fresh-user' });

    expect(mgr.size()).toBe(2);
    await expect(mgr.sweep()).resolves.toBe(1);
    expect(mgr.size()).toBe(1);
    await expect(mgr.sweep()).resolves.toBe(0);
  });
});
