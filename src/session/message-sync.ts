import type { MohoMessageDelete, MohoMessageLocation, MohoMessageUpdate } from '../core/types.js';
import type { Storage } from '../storage/types.js';

export interface OriginalMessageRecord {
  kind: 'message-index';
  botId: string;
  platform: string;
  messageId: string;
  location: MohoMessageLocation;
  content?: string;
  authorId?: string;
  editedAt?: number;
  createdAt?: number;
  deletedAt?: number;
  tombstone: boolean;
  updatedAt: number;
}

export interface MessageSyncOptions {
  storage: Storage;
  now?: () => number;
}

const PREFIX = 'message-index:';

function encode(value: string): string {
  return encodeURIComponent(value);
}

/** Stable storage scope. Thread/forum messages include their parent container. */
export function messageLocationKey(location: MohoMessageLocation): string {
  switch (location.kind) {
    case 'dm': return `dm:${encode(location.channelId)}`;
    case 'thread': return `guild:${encode(location.guildId ?? '')}:thread:${encode(location.channelId)}:parent:${encode(location.parentChannelId ?? '')}`;
    case 'forum-post': return `guild:${encode(location.guildId ?? '')}:forum:${encode(location.parentChannelId ?? '')}:post:${encode(location.channelId)}`;
    case 'guild-text': return `guild:${encode(location.guildId ?? '')}:channel:${encode(location.channelId)}`;
    default: return `${encode(location.kind)}:${encode(location.guildId ?? '')}:${encode(location.channelId)}`;
  }
}

export function messageIndexKey(input: Pick<MohoMessageUpdate | MohoMessageDelete, 'botId' | 'platform' | 'messageId' | 'location'>): string {
  return `${PREFIX}${encode(input.botId)}:${encode(input.platform)}:${messageLocationKey(input.location)}:message:${encode(input.messageId)}`;
}

/** Storage-backed, AI-free, idempotent message lifecycle synchronizer. */
export class MessageSync {
  readonly #storage: Storage;
  readonly #now: () => number;

  constructor(options: MessageSyncOptions) {
    this.#storage = options.storage;
    this.#now = options.now ?? Date.now;
  }

  async update(event: MohoMessageUpdate): Promise<OriginalMessageRecord> {
    const key = messageIndexKey(event);
    const previous = await this.#storage.get<OriginalMessageRecord>(key);
    // A delete is final for this index. Discord can deliver a late update.
    if (previous?.tombstone) return previous;
    const eventTime = event.editedAt;
    if (previous?.editedAt !== undefined && eventTime < previous.editedAt) return previous;
    const record: OriginalMessageRecord = {
      kind: 'message-index',
      botId: event.botId,
      platform: event.platform,
      messageId: event.messageId,
      location: event.location,
      ...(event.content !== undefined ? { content: event.content } : previous?.content !== undefined ? { content: previous.content } : {}),
      ...(event.authorId !== undefined ? { authorId: event.authorId } : previous?.authorId !== undefined ? { authorId: previous.authorId } : {}),
      ...(previous?.createdAt !== undefined ? { createdAt: previous.createdAt } : {}),
      editedAt: eventTime,
      tombstone: false,
      updatedAt: this.#now(),
    };
    await this.#storage.save(key, record);
    return record;
  }

  async delete(event: MohoMessageDelete): Promise<OriginalMessageRecord> {
    const key = messageIndexKey(event);
    const previous = await this.#storage.get<OriginalMessageRecord>(key);
    if (previous?.tombstone && previous.deletedAt !== undefined && previous.deletedAt >= event.deletedAt) return previous;
    const record: OriginalMessageRecord = {
      kind: 'message-index',
      botId: event.botId,
      platform: event.platform,
      messageId: event.messageId,
      location: event.location,
      ...(previous?.content !== undefined ? { content: previous.content } : {}),
      ...(event.authorId !== undefined ? { authorId: event.authorId } : previous?.authorId !== undefined ? { authorId: previous.authorId } : {}),
      ...(previous?.createdAt !== undefined ? { createdAt: previous.createdAt } : {}),
      ...(previous?.editedAt !== undefined ? { editedAt: previous.editedAt } : {}),
      deletedAt: event.deletedAt,
      tombstone: true,
      updatedAt: this.#now(),
    };
    await this.#storage.save(key, record);
    return record;
  }

  async get(event: Pick<MohoMessageUpdate | MohoMessageDelete, 'botId' | 'platform' | 'messageId' | 'location'>): Promise<OriginalMessageRecord | undefined> {
    return this.#storage.get<OriginalMessageRecord>(messageIndexKey(event));
  }
}
