/**
 * Storage abstraction. MVP ships SQLite; Postgres/Redis can implement the same
 * interface later without touching callers.
 */

import type { ChatMessage } from '../core/types.js';

export interface QueryFilter {
  /** Key prefix match, e.g. "session:" */
  prefix?: string;
  limit?: number;
  offset?: number;
}

export interface StoredRecord<T = unknown> {
  key: string;
  value: T;
  updatedAt: number;
  expiresAt?: number;
}

/** Generic key/value store used by sessions, caches and plugins. */
export interface Storage {
  init(): Promise<void>;
  save<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  get<T>(key: string): Promise<T | undefined>;
  delete(key: string): Promise<void>;
  query<T>(filter: QueryFilter): Promise<StoredRecord<T>[]>;
  /** Remove expired rows. Called periodically by a TaskManager job. */
  purgeExpired(): Promise<number>;
  close(): Promise<void>;
}

/** Namespaced view of a Storage, handed to plugins so they cannot collide. */
export interface ScopedStorage {
  save<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  get<T>(key: string): Promise<T | undefined>;
  delete(key: string): Promise<void>;
  query<T>(filter?: Omit<QueryFilter, 'prefix'> & { prefix?: string }): Promise<StoredRecord<T>[]>;
}

/** Shape persisted for one conversation session. */
export interface PersistedSession {
  kind: 'session';
  recordVersion: 1;
  key: string;
  botId: string;
  channelId: string;
  userId?: string;
  messages: ChatMessage[];
  updatedAt: number;
}

/**
 * Future Memory Layer hook. MVP has no implementation, but the pipeline calls
 * through this interface so long-term memory can be dropped in later.
 */
export interface MemoryAdapter {
  readonly name: string;
  /** Extra context injected before the session history. */
  recall(input: { botId: string; channelId: string; userId: string; query: string }): Promise<ChatMessage[]>;
  /** Called after each exchange so the adapter can persist what it wants. */
  remember(input: {
    botId: string;
    channelId: string;
    userId: string;
    user: ChatMessage;
    assistant: ChatMessage;
  }): Promise<void>;
}

/** No-op memory adapter used until a real Memory Layer exists. */
export const nullMemoryAdapter: MemoryAdapter = {
  name: 'null',
  async recall() {
    return [];
  },
  async remember() {
    /* noop */
  },
};
