/** Platform-neutral guild/workspace inventory and planning contracts. */

export type GuildChannelKind = 'category' | 'text' | 'voice' | 'other';

export interface GuildChannelView {
  id: string;
  name: string;
  kind: GuildChannelKind;
  parentId?: string;
  position: number;
  topic?: string;
}

export interface GuildRoleView {
  id: string;
  name: string;
  position: number;
  managed: boolean;
}

export interface GuildInventory {
  guildId: string;
  name: string;
  ownerId: string;
  communityEnabled: boolean;
  channels: GuildChannelView[];
  roles: GuildRoleView[];
}

export type GuildPlanAction =
  | { kind: 'create-category'; name: string }
  | { kind: 'create-text'; category: string; name: string; topic: string }
  | { kind: 'create-voice'; category: string; name: string }
  | { kind: 'move-channel'; channelId: string; category: string }
  | { kind: 'rename-channel'; channelId: string; name: string }
  | { kind: 'set-topic'; channelId: string; topic: string };

export interface GuildPlan {
  guildId: string;
  generatedAt: string;
  communityEnabled: false;
  actions: GuildPlanAction[];
  preservedChannelIds: string[];
  summary: { create: number; move: number; rename: number; topic: number };
}
