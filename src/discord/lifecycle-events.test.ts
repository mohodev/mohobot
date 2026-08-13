import { ChannelType } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { discordMessageLocation, toMessageDeleteEvent, toMessageUpdateEvent, toThreadLifecycleEvent } from './client.js';

describe('Discord lifecycle event adaptation', () => {
  it('handles partial message updates and deletes without fetching or AI work', () => {
    const partial = { id: 'm1', channelId: 'thread1', guildId: 'g1', channel: { type: ChannelType.PublicThread, parentId: 'forum1', parent: { type: ChannelType.GuildForum }, isThread: () => true }, content: null, author: null, editedTimestamp: null, partial: true } as never;
    expect(toMessageUpdateEvent('bot', partial, 123)).toEqual({ botId: 'bot', platform: 'discord', messageId: 'm1', location: { channelId: 'thread1', parentChannelId: 'forum1', guildId: 'g1', kind: 'forum-post' }, content: undefined, authorId: undefined, editedAt: 123, partial: true });
    expect(toMessageDeleteEvent('bot', partial, 456)).toMatchObject({ messageId: 'm1', deletedAt: 456, partial: true, location: { channelId: 'thread1', parentChannelId: 'forum1', kind: 'forum-post' } });
  });

  it('uses the actual thread id as channelId and preserves parent metadata', () => {
    const message = { channelId: 'thread2', guildId: 'g1', channel: { type: ChannelType.PrivateThread, parentId: 'text1', parent: { type: ChannelType.GuildText }, isThread: () => true } } as never;
    expect(discordMessageLocation(message)).toEqual({ channelId: 'thread2', parentChannelId: 'text1', guildId: 'g1', kind: 'thread' });
  });

  it('marks forum lifecycle events while keeping the post id as channelId', () => {
    const thread = { id: 'post1', parentId: 'forum1', guildId: 'g1', name: 'topic', parent: { type: ChannelType.GuildForum }, archived: false, locked: true } as never;
    expect(toThreadLifecycleEvent('bot', 'update', thread, 789)).toEqual({ botId: 'bot', platform: 'discord', action: 'update', channelId: 'post1', parentChannelId: 'forum1', guildId: 'g1', name: 'topic', forumPost: true, archived: false, locked: true, partial: false, occurredAt: 789 });
  });
});
