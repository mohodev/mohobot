/**
 * Gateway contract.
 *
 * The only module allowed to import discord.js is src/discord/client.ts.
 * Everything else programs against Gateway + Moho events.
 */

import type { BotId, Managed, OutboundMessage } from '../core/types.js';
import type { GuildInventory, GuildPlan } from './guild-admin.js';

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
  readonly platform: 'discord' | 'console' | 'webhook';
  send(out: OutboundMessage): Promise<DeliveryResult>;
  /** Show a typing indicator; no-op when unsupported. Must never throw. */
  typing(channelId: string): Promise<void>;
  status(): GatewayStatus;
  guildInventory?(guildId: string): Promise<GuildInventory>;
  /** Guilds visible to this bot. Used by broadcast targeting. */
  listGuilds?(): Promise<Array<{ id: string; name: string }>>;
  applyGuildPlan?(plan: GuildPlan): Promise<{ applied: number; skipped: number }>;
}
