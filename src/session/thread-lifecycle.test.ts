import { describe, expect, it, vi } from 'vitest';
import { SessionConfigSchema } from '../config/schema.js';
import { createNullLogger } from '../core/logger.js';
import { MemoryStorage } from '../storage/memory.js';
import { ThreadLifecycleStore, threadStateKey } from './thread-lifecycle.js';

const base = { botId: 'bot', platform: 'discord' as const, action: 'delete' as const, channelId: 'thread1', parentChannelId: 'parent1', guildId: 'g1', forumPost: false, partial: false, occurredAt: 10 };

describe('ThreadLifecycleStore', () => {
  it('persists a tombstone and clears isolated sessions', async () => {
    const storage = new MemoryStorage({ logger: createNullLogger() }); await storage.init();
    const clearChannel = vi.fn(async () => 2);
    const store = new ThreadLifecycleStore(storage, createNullLogger());
    const result = await store.apply(base, SessionConfigSchema.parse({}), { clearChannel } as never);
    expect(result.tombstone).toBe(true);
    expect(clearChannel).toHaveBeenCalledWith('thread1');
    expect((await storage.get<{ tombstone: boolean }>(threadStateKey('bot', 'thread1')))?.tombstone).toBe(true);
  });

  it('keeps shared parent sessions when thread or forum inherits parent', async () => {
    const storage = new MemoryStorage({ logger: createNullLogger() }); await storage.init();
    const clearChannel = vi.fn();
    const store = new ThreadLifecycleStore(storage, createNullLogger());
    await store.apply(base, SessionConfigSchema.parse({ threadContext: 'inherit-parent' }), { clearChannel } as never);
    await store.apply({ ...base, channelId: 'post1', forumPost: true }, SessionConfigSchema.parse({ forumContext: 'inherit-parent' }), { clearChannel } as never);
    expect(clearChannel).not.toHaveBeenCalled();
  });

  it('does not resurrect a deleted thread from late lifecycle updates', async () => {
    const storage = new MemoryStorage({ logger: createNullLogger() }); await storage.init();
    const store = new ThreadLifecycleStore(storage, createNullLogger());
    const sessions = { clearChannel: vi.fn() } as never;
    await store.apply(base, SessionConfigSchema.parse({}), sessions);
    const result = await store.apply({ ...base, action: 'update', occurredAt: 11, name: 'late' }, SessionConfigSchema.parse({}), sessions);
    expect(result.tombstone).toBe(true);
    expect(result.name).toBeUndefined();
  });
});
