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
    async query<T>(filter: QueryFilter): Promise<StoredRecord<T>[]> {
      return [...data.entries()]
        .filter(([key]) => !filter.prefix || key.startsWith(filter.prefix))
        .map(([key, value]) => ({ key, value: value as T, updatedAt: Date.now() }));
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

  it('stamps user turns with a local time prefix for time awareness', async () => {
    const memory: MemoryAdapter = { name: 'test-memory', async recall() { return []; }, async remember() {} };
    const mgr = new SessionManager({ botId: 'bot1', config: config(), logger, memory });
    // 2026-08-23 13:45 local time
    const d = new Date();
    d.setFullYear(2026, 7, 23);
    d.setHours(13, 45, 0, 0);
    await mgr.append(input, { ...user('在吗'), createdAt: d.getTime() });
    await mgr.append(input, user('no timestamp here'));
    await mgr.append(input, { role: 'assistant', content: '在的', createdAt: d.getTime() + 1000 });

    const ctx = await mgr.buildContext(input, 'SYS');
    const pad = (n: number): string => String(n).padStart(2, '0');
    const stamp = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    expect(ctx[1]?.content).toBe(`[${stamp}] 在吗`);
    expect(ctx[2]?.content).toBe('no timestamp here'); // no createdAt → untouched
    expect(ctx[3]?.content).toBe('在的'); // assistant turns never stamped
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

    expect(storage.data.get('session:bot1:chan1:user1')).toMatchObject({kind:'session',recordVersion:1});

    const second = new SessionManager({ botId: 'bot1', config: cfg, logger, storage });
    const restored = await second.get(input);
    expect(restored.messages.map((m) => m.content)).toEqual(['remember me', 'noted']);
    expect(restored.key).toBe('session:bot1:chan1:user1');
  });

  it('strictly decodes legacy records, drops bad messages, and rejects future sessions', async () => {
    const storage=fakeStorage();const key='session:bot1:chan1:user1';
    storage.data.set(key,{key,botId:'bot1',channelId:'chan1',userId:'user1',messages:[{role:'user',content:'legacy ok'},{role:'root',content:'bad'},{role:'user',content:7}],updatedAt:10});
    const legacy=new SessionManager({botId:'bot1',config:config({persist:true}),logger,storage});
    expect((await legacy.get(input)).messages.map(m=>m.content)).toEqual(['legacy ok']);
    storage.data.set(key,{kind:'session',recordVersion:2,key,botId:'bot1',channelId:'chan1',userId:'user1',messages:[{role:'user',content:'future'}],updatedAt:11});
    const future=new SessionManager({botId:'bot1',config:config({persist:true}),logger,storage});
    expect((await future.get(input)).messages).toEqual([]);await future.append(input,user('must not overwrite'));await future.flush();
    expect(storage.data.get(key)).toMatchObject({recordVersion:2});
  });

  it('deduplicates concurrent cold hydration by promise', async () => {
    const storage=fakeStorage();const key='session:bot1:chan1:user1';let reads=0;let release!:()=>void;
    const blocked=new Promise<void>(resolve=>{release=resolve});const original=storage.get.bind(storage);
    storage.get=async<T>(k:string)=>{reads+=1;await blocked;return original<T>(k)};
    storage.data.set(key,{kind:'session',recordVersion:1,key,botId:'bot1',channelId:'chan1',userId:'user1',messages:[],updatedAt:10});
    const manager=new SessionManager({botId:'bot1',config:config({persist:true}),logger,storage});
    const one=manager.get(input);const two=manager.get(input);expect(reads).toBe(1);release();
    const[a,b]=await Promise.all([one,two]);expect(a).toBe(b);expect(manager.size()).toBe(1);
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

describe('SessionManager source lifecycle corrections', () => {
  const sourced = (content: string): ChatMessage => ({
    role: 'user', content, sourceMessageId: 'discord-message-1', sourcePlatform: 'discord', createdAt: 100,
  });

  it('updates a persisted user-scoped session after restart without authorId', async () => {
    const storage = fakeStorage();
    const cfg = config({ persist: true, scope: 'user' });
    const first = new SessionManager({ botId: 'bot1', config: cfg, logger, storage });
    await first.append(input, sourced('before edit'));
    await first.flush();

    const restarted = new SessionManager({ botId: 'bot1', config: cfg, logger, storage });
    const update = {
      botId: 'bot1', channelId: 'chan1', sourceMessageId: 'discord-message-1', sourcePlatform: 'discord' as const, content: 'after edit',
    };
    await expect(restarted.updateSourceMessage(update)).resolves.toBe(true);
    await expect(restarted.updateSourceMessage(update)).resolves.toBe(false);
    await restarted.flush();

    const restored = await restarted.get(input);
    expect(restored.messages[0]).toMatchObject({ content: 'after edit', sourceMessageId: 'discord-message-1' });
    expect(restored.messages[0]).not.toHaveProperty('deleted');
  });

  it('keeps a delete tombstone persisted and excludes it from model context', async () => {
    const storage = fakeStorage();
    const cfg = config({ persist: true, scope: 'user' });
    const manager = new SessionManager({ botId: 'bot1', config: cfg, logger, storage });
    await manager.append(input, sourced('remove me'));
    await expect(manager.deleteSourceMessage({
      ...input, sourceMessageId: 'discord-message-1', sourcePlatform: 'discord',
    })).resolves.toBe(true);
    await manager.flush();

    expect((await manager.get(input)).messages[0]).toMatchObject({ content: 'remove me', deleted: true });
    expect((await manager.buildContext(input, 'SYS')).map((message) => message.content)).toEqual(['SYS']);

    const restarted = new SessionManager({ botId: 'bot1', config: cfg, logger, storage });
    expect((await restarted.get(input)).messages[0]).toMatchObject({ content: 'remove me', deleted: true });
    expect((await restarted.buildContext(input, 'SYS')).map((message) => message.content)).toEqual(['SYS']);
  });

  it('does not let a late update revive a deleted source message', async () => {
    const manager = new SessionManager({ botId: 'bot1', config: config({ scope: 'channel' }), logger });
    await manager.append(input, sourced('original'));
    const mutation = { botId: 'bot1', channelId: 'chan1', sourceMessageId: 'discord-message-1', sourcePlatform: 'discord' as const };
    await expect(manager.deleteSourceMessage(mutation)).resolves.toBe(true);
    await expect(manager.deleteSourceMessage(mutation)).resolves.toBe(false);
    await expect(manager.updateSourceMessage({ ...mutation, content: 'late edit' })).resolves.toBe(false);
    expect((await manager.get(input)).messages[0]).toMatchObject({ content: 'original', deleted: true });
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

describe('Thread and forum context policy', () => {
  it('isolates thread/forum containers by default', async () => {
    const { effectiveSessionChannelId } = await import('./context-policy.js');
    const cfg = config();
    const thread = { channel: { id: 'thread1', dm: false, parentChannelId: 'parent1', location: { channelId: 'thread1', parentChannelId: 'parent1', guildId: 'g1', kind: 'thread' } } } as never;
    const forum = { channel: { id: 'post1', dm: false, parentChannelId: 'forum1', location: { channelId: 'post1', parentChannelId: 'forum1', guildId: 'g1', kind: 'forum-post' } } } as never;
    expect(effectiveSessionChannelId(cfg, thread)).toBe('thread1');
    expect(effectiveSessionChannelId(cfg, forum)).toBe('post1');
  });

  it('inherits parent independently for thread and forum while preserving user scope', async () => {
    const { effectiveSessionChannelId } = await import('./context-policy.js');
    const cfg = config({ threadContext: 'inherit-parent', forumContext: 'inherit-parent', scope: 'user' });
    const thread = { channel: { id: 'thread1', dm: false, location: { channelId: 'thread1', parentChannelId: 'parent1', kind: 'thread' } } } as never;
    const effective = effectiveSessionChannelId(cfg, thread);
    const mgr = new SessionManager({ botId: 'bot1', config: cfg, logger });
    expect(effective).toBe('parent1');
    expect((await mgr.get({ botId: 'bot1', channelId: effective, userId: 'u1' })).key).toBe('session:bot1:parent1:u1');
    expect((await mgr.get({ botId: 'bot1', channelId: effective, userId: 'u2' })).key).toBe('session:bot1:parent1:u2');
  });

  it('clearChannel removes channel and every user-scoped child without prefix collisions', async () => {
    const storage = fakeStorage();
    const mgr = new SessionManager({ botId: 'bot1', config: config({ persist: true, scope: 'user' }), logger, storage });
    await mgr.append({ botId: 'bot1', channelId: 'thread1', userId: 'u1' }, user('one'));
    await mgr.append({ botId: 'bot1', channelId: 'thread1', userId: 'u2' }, user('two'));
    await mgr.append({ botId: 'bot1', channelId: 'thread10', userId: 'u1' }, user('keep'));
    await mgr.flush();
    expect(await mgr.clearChannel('thread1')).toBe(2);
    await mgr.flush();
    expect([...storage.data.keys()]).toEqual(['session:bot1:thread10:u1']);
  });
});
