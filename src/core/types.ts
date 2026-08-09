/**
 * MohoBot core domain model.
 *
 * Nothing in here may import discord.js, better-sqlite3, or any provider SDK.
 * This file is the shared contract every module compiles against.
 */

export type BotId = string;
export type PluginId = string;

/** Where a message came from. Discord today, other gateways later. */
export type Platform = 'discord' | 'console';

export interface MohoUser {
  /** Platform-native user id (Discord snowflake). */
  id: string;
  username: string;
  displayName?: string;
  bot: boolean;
}

export interface MohoChannel {
  /** Platform-native channel id. */
  id: string;
  /** Guild / server id. Undefined for DMs. */
  guildId?: string;
  name?: string;
  dm: boolean;
}

export interface MohoAttachment {
  id: string;
  url: string;
  name?: string;
  contentType?: string;
  size?: number;
}

/** Platform-agnostic inbound message. Business logic only ever sees this. */
export interface MohoMessage {
  id: string;
  platform: Platform;
  botId: BotId;
  channel: MohoChannel;
  author: MohoUser;
  content: string;
  /** True when the bot was @-mentioned or replied to. */
  mentionsBot: boolean;
  /** Message id this message replies to, if any. */
  replyToId?: string;
  attachments: MohoAttachment[];
  createdAt: number;
  /** Escape hatch for adapter-specific data. Never depended on by core. */
  raw?: unknown;
}

/** Everything needed to send something back out through a gateway. */
export interface OutboundMessage {
  channelId: string;
  content: string;
  /** Reply to this message id when the gateway supports it. */
  replyToId?: string;
  /** Suppress @everyone / role pings regardless of content. */
  suppressMentions?: boolean;
}

/** Chat turn as stored in a session and sent to the AI provider. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** Optional display name, forwarded to providers that support it. */
  name?: string;
}

export type ComponentState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'degraded'
  | 'stopping'
  | 'crashed';

export interface ComponentStatus {
  name: string;
  state: ComponentState;
  since: number;
  restarts: number;
  lastError?: string;
}

/**
 * Anything the Supervisor can own. Start/stop must be idempotent and must never
 * throw for a reason the caller cannot act on - throw only on real failure.
 */
export interface Managed {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface Disposable {
  dispose(): void | Promise<void>;
}
