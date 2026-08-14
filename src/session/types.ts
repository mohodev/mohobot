/**
 * Session contract - MVP short-term context only.
 * Long-term memory arrives later behind MemoryAdapter (src/storage/types.ts).
 */

import type { ChatMessage, Platform } from '../core/types.js';

export interface SessionKeyInput {
  botId: string;
  channelId: string;
  userId: string;
}

export interface SourceMessageMutation {
  botId: string;
  channelId: string;
  userId?: string;
  sourceMessageId: string;
  sourcePlatform: Platform;
}

export interface SourceMessageUpdate extends SourceMessageMutation {
  content: string;
}

export interface Session {
  key: string;
  botId: string;
  channelId: string;
  userId?: string;
  messages: ChatMessage[];
  updatedAt: number;
}

export interface SessionManagerLike {
  /** Load (or create) the session for this user/channel. */
  get(input: SessionKeyInput): Promise<Session>;
  /** Append a turn and trim to the configured window. */
  append(input: SessionKeyInput, message: ChatMessage): Promise<void>;
  /**
   * Persist the assistant turn and notify the long-term memory adapter.
   * Optional: implementations without long-term memory may omit it and the
   * pipeline falls back to a plain append.
   */
  completeExchange?(input: SessionKeyInput, user: ChatMessage, assistant: ChatMessage): Promise<void>;
  /** Correct a persisted user turn by its source message identity. */
  updateSourceMessage?(input: SourceMessageUpdate): Promise<boolean>;
  /** Preserve a tombstone while removing the turn from future model context. */
  deleteSourceMessage?(input: SourceMessageMutation): Promise<boolean>;
  /** Assemble the prompt: system + (memory) + trimmed history. */
  buildContext(input: SessionKeyInput, systemPrompt: string): Promise<ChatMessage[]>;
  clear(input: SessionKeyInput): Promise<void>;
  /** Clear every user-scoped or channel-scoped session for one effective channel. */
  clearChannel?(channelId: string): Promise<number>;
  /** Drop idle sessions; returns how many were removed. */
  sweep(): Promise<number>;
  size(): number;
}
