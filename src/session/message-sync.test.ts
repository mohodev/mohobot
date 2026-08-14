import { beforeEach, describe, expect, it } from 'vitest';
import { createNullLogger } from '../core/logger.js';
import type { MohoMessageDelete, MohoMessageLocation, MohoMessageUpdate } from '../core/types.js';
import { MemoryStorage } from '../storage/memory.js';
import { MessageSync, messageIndexKey, messageLocationKey } from './message-sync.js';

const thread: MohoMessageLocation = { channelId: 'thread:1', parentChannelId: 'parent:1', guildId: 'guild:1', kind: 'thread' };
const forum: MohoMessageLocation = { channelId: 'post:1', parentChannelId: 'forum:1', guildId: 'guild:1', kind: 'forum-post' };
const update = (overrides: Partial<MohoMessageUpdate> = {}): MohoMessageUpdate => ({ botId: 'bot', platform: 'discord', messageId: 'msg', location: thread, content: 'edited', authorId: 'user', editedAt: 200, partial: false, ...overrides });
const deletion = (overrides: Partial<MohoMessageDelete> = {}): MohoMessageDelete => ({ botId: 'bot', platform: 'discord', messageId: 'msg', location: thread, authorId: 'user', deletedAt: 300, partial: false, ...overrides });

describe('MessageSync', () => {
  let storage: MemoryStorage;
  let sync: MessageSync;
  beforeEach(async () => { storage = new MemoryStorage({ logger: createNullLogger() }); await storage.init(); sync = new MessageSync({ storage, now: () => 999 }); });

  it('uses actual thread/post ids while preserving parent scope', () => {
    expect(messageLocationKey(thread)).toContain('thread:thread%3A1:parent:parent%3A1');
    expect(messageLocationKey(forum)).toContain('forum:forum%3A1:post:post%3A1');
    expect(messageIndexKey(update())).not.toBe(messageIndexKey(update({ location: forum })));
  });

  it('stores updates idempotently and rejects stale updates', async () => {
    const first = await sync.update(update());
    expect(first).toMatchObject({ content: 'edited', editedAt: 200, tombstone: false });
    const repeated = await sync.update(update());
    expect(repeated).toMatchObject({ content: 'edited', editedAt: 200, tombstone: false });
    const stale = await sync.update(update({ content: 'old', editedAt: 100 }));
    expect(stale.content).toBe('edited');
    expect((await storage.query({ prefix: 'message-index:' }))).toHaveLength(1);
  });

  it('preserves known fields when a partial update omits them', async () => {
    await sync.update(update({ content: 'known', authorId: 'known-user' }));
    const partial = await sync.update(update({ content: undefined, authorId: undefined, editedAt: 250, partial: true }));
    expect(partial).toMatchObject({ content: 'known', authorId: 'known-user', editedAt: 250 });
  });

  it('creates an idempotent delete tombstone and never resurrects it', async () => {
    await sync.update(update());
    const tombstone = await sync.delete(deletion());
    expect(tombstone).toMatchObject({ tombstone: true, deletedAt: 300, content: 'edited' });
    const repeated = await sync.delete(deletion({ deletedAt: 250 }));
    expect(repeated.deletedAt).toBe(300);
    const lateUpdate = await sync.update(update({ content: 'resurrect', editedAt: 400 }));
    expect(lateUpdate.tombstone).toBe(true);
    expect(lateUpdate.content).toBe('edited');
  });

  it('creates a tombstone when delete arrives without an indexed update', async () => {
    const result = await sync.delete(deletion({ messageId: 'missing', partial: true, authorId: undefined }));
    expect(result).toMatchObject({ messageId: 'missing', tombstone: true, deletedAt: 300 });
    expect(await sync.get(deletion({ messageId: 'missing' }))).toEqual(result);
  });
});
