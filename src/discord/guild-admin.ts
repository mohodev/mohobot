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

const BLUEPRINT = [
  { kind: 'category' as const, name: '管理区' },
  { kind: 'text' as const, category: '管理区', name: 'bot-控制台', topic: '机器人管理指令、状态与受控操作记录。' },
  { kind: 'text' as const, category: '管理区', name: 'bot-日志', topic: '机器人运行、错误与维护通知。' },
  { kind: 'text' as const, category: '管理区', name: '变更-确认', topic: '频道整理、权限调整等变更的确认与审计。' },
  { kind: 'category' as const, name: '文字区' },
  { kind: 'text' as const, category: '文字区', name: '公告', topic: '服务器公告与重要通知。' },
  { kind: 'text' as const, category: '文字区', name: '常规', topic: '日常聊天。' },
  { kind: 'text' as const, category: '文字区', name: '机器人', topic: '与机器人交互和测试。' },
  { kind: 'text' as const, category: '文字区', name: '资料', topic: '服务器资料、规范与链接。' },
  { kind: 'category' as const, name: '语音区' },
  { kind: 'voice' as const, category: '语音区', name: '常规' },
  { kind: 'voice' as const, category: '语音区', name: '备用' },
];

const key = (kind: GuildChannelKind, name: string) => `${kind}:${name.toLowerCase()}`;

/** A conservative plan: it never deletes channels, roles, members, or permissions. */
export function buildInternalGuildPlan(inventory: GuildInventory, now = new Date()): GuildPlan {
  const channels = inventory.channels.filter((channel) => channel.kind !== 'other');
  const byKey = new Map(channels.map((channel) => [key(channel.kind, channel.name), channel]));
  const categories = new Map(channels.filter((channel) => channel.kind === 'category').map((channel) => [channel.name.toLowerCase(), channel]));
  const actions: GuildPlanAction[] = [];
  const preserved = new Set(channels.map((channel) => channel.id));

  for (const item of BLUEPRINT) {
    if (item.kind === 'category') {
      if (!byKey.has(key('category', item.name))) actions.push({ kind: 'create-category', name: item.name });
      continue;
    }
    const channel = byKey.get(key(item.kind, item.name));
    if (!channel) {
      if (item.kind === 'text') actions.push({ kind: 'create-text', category: item.category, name: item.name, topic: item.topic });
      else actions.push({ kind: 'create-voice', category: item.category, name: item.name });
      continue;
    }
    const parent = categories.get(item.category.toLowerCase());
    if (parent && channel.parentId !== parent.id) actions.push({ kind: 'move-channel', channelId: channel.id, category: item.category });
    if (item.kind === 'text' && channel.topic !== item.topic) actions.push({ kind: 'set-topic', channelId: channel.id, topic: item.topic });
  }
  const summary = { create: 0, move: 0, rename: 0, topic: 0 };
  for (const action of actions) {
    if (action.kind.startsWith('create-')) summary.create += 1;
    else if (action.kind === 'move-channel') summary.move += 1;
    else if (action.kind === 'rename-channel') summary.rename += 1;
    else summary.topic += 1;
  }
  return { guildId: inventory.guildId, generatedAt: now.toISOString(), communityEnabled: false, actions, preservedChannelIds: [...preserved], summary };
}
