/**
 * Platform adapter contract.
 *
 * Domain/runtime code depends on this file, never on a concrete messaging SDK.
 * Concrete adapters normalize inbound events into MohoMessage and implement
 * this outbound/control surface. Platform IDs are open strings so extensions
 * can register adapters without modifying the core type union.
 */

import type { BotId, Managed, OutboundMessage, Platform } from '../core/types.js';
import type { GuildInventory, GuildPlan } from './guild.js';

export type PlatformId = Platform;

export interface DeliveryResult {
  status: 'delivered' | 'rejected' | 'unknown';
  messageId?: string;
  error?: string;
}

export interface GatewayStatus {
  connected: boolean;
  /** Gateway heartbeat latency in ms, -1 when unknown. */
  ping: number;
  username?: string;
  guilds?: number;
  reconnects: number;
  lastError?: string;
}

export interface Gateway extends Managed {
  readonly botId: BotId;
  readonly platform: PlatformId;
  send(out: OutboundMessage): Promise<DeliveryResult>;
  /** Show a typing indicator; no-op when unsupported. Must never throw. */
  typing(channelId: string): Promise<void>;
  status(): GatewayStatus;

  /** Optional workspace/guild management capability; adapters may omit it. */
  guildInventory?(guildId: string): Promise<GuildInventory>;
  /** Visible workspaces/guilds; used only by features that require enumeration. */
  listGuilds?(): Promise<Array<{ id: string; name: string }>>;
  /** Apply a conservative workspace/guild plan; adapters may omit it. */
  applyGuildPlan?(plan: GuildPlan): Promise<{ applied: number; skipped: number }>;
}
