/**
 * ban - global ban list for MohoBot.
 *
 * A faithful, platform-agnostic port of the upstream carefreesongs712/mohobot
 * ban system (astrbot_plugin_reneban lineage). The bot SILENTLY ignores a
 * banned user's messages; it is not a server moderation ban.
 *
 * Commands (admin-only unless noted), all prefixed with `!`:
 *   !ban <@user|id> [duration] [reason]   ban in the current channel (DM = global)
 *   !ban-all <@user|id> [duration] [reason]  global ban
 *   !pass <@user|id> [duration]           temporary unban (channel)
 *   !pass-all <@user|id> [duration]       temporary unban (global)
 *   !unban <@user|id>                     remove ban in current scope
 *   !unban-all <@user|id>                 remove global ban
 *   !banlist                              list all records (admin)
 *   !ban-help                             this help (everyone)
 *
 * Duration: 1d / 2h / 30m / 10s, combinable (1d2h); omitted = permanent.
 * Priority: channel pass > channel ban > global pass > global ban.
 */

import type { Plugin, PluginContext } from '../../src/plugins/types.js';
import type { MohoMessage } from '../../src/core/types.js';
import { BanStore, type BanScope } from './store.js';
import { describeUntil, parseDuration } from './time.js';

let store: BanStore | undefined;
let ctx: PluginContext | undefined;

function isAdmin(message: { author: { isBotManager?: boolean } }): boolean {
  return message.author.isBotManager === true;
}

/** Extract a Discord user id from a mention (<@123>, <@!123>) or a raw id. */
export function parseTarget(arg: string | undefined): string | undefined {
  if (!arg) return undefined;
  const mention = arg.match(/^<@!?(\d+)>$/);
  if (mention) return mention[1];
  if (/^\d+$/.test(arg)) return arg;
  return undefined;
}

function scopeFor(channel: { dm: boolean }): BanScope {
  return channel.dm ? 'global' : 'channel';
}

const HELP = [
  '`!ban <@用户|ID> [时长] [理由]` 当前频道封禁（私聊=全局）',
  '`!ban-all <@用户|ID> [时长] [理由]` 全局封禁',
  '`!pass <@用户|ID> [时长]` 临时解禁（当前频道）',
  '`!pass-all <@用户|ID> [时长]` 全局临时解禁',
  '`!unban <@用户|ID>` 解除当前范围封禁',
  '`!unban-all <@用户|ID>` 解除全局封禁',
  '`!banlist` 查看封禁名单',
  '时长格式：`1d` `2h` `30m` `10s`，可组合如 `1d2h`；省略=永久',
].join('\n');

function handleBan(args: string[], isAll: boolean, message: MohoMessage): string {
  const s = store!;
  const target = parseTarget(args[0]);
  if (!target) return '用法：!ban <@用户|ID> [时长] [理由]';
  const durationInput = args[1] ?? '';
  let until: number | undefined;
  try {
    until = parseDuration(durationInput).until;
  } catch (error) {
    return `时长解析失败：${(error as Error).message}`;
  }
  const reason = args.slice(2).join(' ').trim() || undefined;
  const scope: BanScope = isAll ? 'global' : scopeFor(message.channel);
  void s.add({
    kind: 'ban',
    userId: target,
    scope,
    channelId: scope === 'channel' ? message.channel.id : undefined,
    until,
    reason,
    by: message.author.id,
    createdAt: Date.now(),
  });
  return `已封禁 <@${target}>（${scope === 'global' ? '全局' : '本频道'}，${describeUntil(until)}）${reason ? `理由：${reason}` : ''}`;
}

function handlePass(args: string[], isAll: boolean, message: MohoMessage): string {
  const s = store!;
  const target = parseTarget(args[0]);
  if (!target) return '用法：!pass <@用户|ID> [时长]';
  let until: number | undefined;
  try {
    until = parseDuration(args[1] ?? '').until;
  } catch (error) {
    return `时长解析失败：${(error as Error).message}`;
  }
  const scope: BanScope = isAll ? 'global' : scopeFor(message.channel);
  void s.add({
    kind: 'pass',
    userId: target,
    scope,
    channelId: scope === 'channel' ? message.channel.id : undefined,
    until,
    by: message.author.id,
    createdAt: Date.now(),
  });
  return `已临时解禁 <@${target}>（${scope === 'global' ? '全局' : '本频道'}，${describeUntil(until)}）`;
}

function handleUnban(args: string[], isAll: boolean, message: MohoMessage): string {
  const s = store!;
  const target = parseTarget(args[0]);
  if (!target) return '用法：!unban <@用户|ID>';
  const scope: BanScope = isAll ? 'global' : scopeFor(message.channel);
  const removed = s.remove(target, scope, scope === 'channel' ? message.channel.id : undefined);
  void removed.then((count) => ctx?.logger.info({ target, count }, 'ban records removed'));
  return `已解除 <@${target}> 的${scope === 'global' ? '全局' : '本频道'}封禁`;
}

function handleList(): string {
  const s = store!;
  const records = s.records();
  if (records.length === 0) return '封禁名单为空。';
  const lines = records.map((r) => {
    const kind = r.kind === 'pass' ? '解禁' : '封禁';
    const scope = r.scope === 'global' ? '全局' : `<#${r.channelId}>`;
    return `- <@${r.userId}> ${kind} ${scope} ${describeUntil(r.until)}${r.reason ? `（${r.reason}）` : ''}`;
  });
  return `封禁名单（${records.length}）：\n${lines.join('\n')}`;
}

const plugin: Plugin = {
  name: 'ban',

  async onLoad(context) {
    ctx = context;
    store = new BanStore(context.storage);
    await store.load();
    store.prune();

    context.registerCommand({ name: 'ban', description: '封禁用户（管理员）', execute: () => HELP });
    context.registerCommand({ name: 'ban-help', description: '封禁系统帮助', execute: () => HELP });
    context.registerCommand({ name: 'banlist', description: '查看封禁名单（管理员）', execute: () => '请使用 !banlist' });
    context.registerCommand({ name: 'unban', description: '解除封禁（管理员）', execute: () => HELP });

    context.logger.info('ban plugin ready');
  },

  onUnload() {
    store = undefined;
    ctx = undefined;
  },

  onMessage(message) {
    if (!store) return undefined;

    const text = message.content.trim();
    const m = text.match(/^!([a-z-]+)(?:\s+(.*))?$/is);
    if (m) {
      const name = m[1]?.toLowerCase();
      const rest = m[2] ?? '';
      const args = rest.length > 0 ? rest.split(/\s+/) : [];

      if (name === 'ban-help') return { stop: true, reply: HELP };
      if (['ban', 'ban-all', 'pass', 'pass-all', 'unban', 'unban-all', 'banlist'].includes(name ?? '')) {
        if (!isAdmin(message)) return { stop: true }; // silent: never leak privilege state
        let reply: string;
        switch (name) {
          case 'ban': reply = handleBan(args, false, message); break;
          case 'ban-all': reply = handleBan(args, true, message); break;
          case 'pass': reply = handlePass(args, false, message); break;
          case 'pass-all': reply = handlePass(args, true, message); break;
          case 'unban': reply = handleUnban(args, false, message); break;
          case 'unban-all': reply = handleUnban(args, true, message); break;
          default: reply = handleList(); break;
        }
        return { stop: true, reply };
      }
    }

    // Silent gate for banned users (admins can always speak so they can unban).
    if (isAdmin(message)) return undefined;
    if (message.author.bot) return undefined;
    const result = store.resolve(message.author.id, message.channel.id);
    if (result.banned) return { stop: true };
    return undefined;
  },
};

export default plugin;
