import type { Plugin } from '../../src/plugins/types.js';
import type { MohoMessage } from '../../src/core/types.js';
import { WorldStore } from '../../src/admin/world.js';
import { AffinityStore } from '../../src/admin/affinity.js';

let world: WorldStore | undefined;
let affinity: AffinityStore | undefined;

function score(message: MohoMessage): number {
  const text = message.content.toLowerCase();
  let value = 0.25;
  if (message.mentionsBot || message.channel.dm) value += 0.45;
  if (/[?？]/.test(text)) value += 0.15;
  if (/(难过|崩溃|急|救命|怎么办|哭)/.test(text)) value += 0.2;
  if (text.length > 180) value -= 0.1;
  return Math.max(0, Math.min(1, value));
}

const plugin: Plugin = {
  name: 'human-simulator',
  onLoad(ctx) {
    world = new WorldStore(process.env.MOHO_ROOT || process.cwd());
    affinity = new AffinityStore(process.env.MOHO_ROOT || process.cwd());
    ctx.registerCommand({
      name: 'world',
      description: '查看世界状态',
      execute: async () => {
        const state = await world!.get();
        return `世界：${state.location}｜天气：${state.weather}｜活动：${state.activity}\n能量 ${state.mood.energy.toFixed(2)} 社交 ${state.mood.sociability.toFixed(2)} 压力 ${state.mood.stress.toFixed(2)}`;
      },
    });
    ctx.registerCommand({
      name: 'mood',
      description: '查看本条消息的发言必要性',
      execute: (command) => `发言必要性 ${(score(command.message) * 100).toFixed(0)}%`,
    });
    ctx.registerCommand({
      name: 'affinity',
      description: '查看与用户的好感度',
      execute: async (command) => {
        const userId = command.message.author.id;
        const row = await affinity!.get(command.message.botId, userId);
        return `对 ${command.message.author.username} 的好感度：${row.score.toFixed(0)}\n互动 ${row.interactions} 次，最近原因：${row.lastReason}`;
      },
    });
    ctx.registerCommand({
      name: 'like',
      description: '!like <分值> [备注]（测试用）',
      execute: async (command) => {
        const delta = Math.max(-10, Math.min(10, Number(command.args[0] ?? 1) || 1));
        const row = await affinity!.adjust(command.message.botId, command.message.author.id, delta, 'manual', command.args.slice(1).join(' '));
        return `好感度已更新：${row.score.toFixed(0)}`;
      },
    });
    ctx.registerCommand({
      name: 'simulate',
      description: '!simulate <social|conflict|rest> <事件>',
      execute: async (command) => {
        const type = command.args[0] ?? 'social';
        const text = command.args.slice(1).join(' ') || '世界发生了一件小事';
        const state = await world!.event(type, text);
        return `已模拟 ${type}：${text}\n压力 ${state.mood.stress.toFixed(2)}，能量 ${state.mood.energy.toFixed(2)}`;
      },
    });
  },
  onMessage(message) {
    const necessity = score(message);
    if (!message.mentionsBot && !message.channel.dm && necessity < 0.35) return { stop: false };
    return undefined;
  },
  onUnload() {
    world = undefined;
    affinity = undefined;
  },
};

export default plugin;
