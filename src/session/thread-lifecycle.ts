import type { SessionConfig } from '../config/schema.js';
import type { Logger } from '../core/logger.js';
import type { MohoThreadLifecycle } from '../core/types.js';
import type { Storage } from '../storage/types.js';
import type { SessionManagerLike } from './types.js';
import { lifecycleUsesParent } from './context-policy.js';

export interface ThreadStateRecord extends MohoThreadLifecycle {
  kind: 'thread-state';
  tombstone: boolean;
  updatedAt: number;
}

export function threadStateKey(botId: string, channelId: string): string {
  return `thread-state:${encodeURIComponent(botId)}:${encodeURIComponent(channelId)}`;
}

/** Persists Discord thread/forum lifecycle and safely converges out-of-order events. */
export class ThreadLifecycleStore {
  constructor(private readonly storage: Storage, private readonly logger: Logger) {}

  async apply(event: MohoThreadLifecycle, config: SessionConfig, sessions: SessionManagerLike): Promise<ThreadStateRecord> {
    const key = threadStateKey(event.botId, event.channelId);
    const previous = await this.storage.get<ThreadStateRecord>(key);
    if (previous && previous.occurredAt > event.occurredAt) return previous;
    if (previous?.tombstone && event.action !== 'delete') return previous;
    const record: ThreadStateRecord = { ...event, kind: 'thread-state', tombstone: event.action === 'delete', updatedAt: Date.now() };
    await this.storage.save(key, record);
    if (event.action === 'delete' && !lifecycleUsesParent(config, event)) {
      try {
        await sessions.clearChannel?.(event.channelId);
      } catch (error) {
        this.logger.warn({ channelId: event.channelId, err: error }, 'deleted thread session cleanup failed');
      }
    }
    return record;
  }
}
