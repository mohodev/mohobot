import type { WorldState } from '../admin/world.js';

export type PublicPresenceStatus = 'online' | 'idle' | 'dnd' | 'invisible';
export interface PublicPresence { status: PublicPresenceStatus; activity: string; afk: boolean; }

/** Maps internal simulation to a deliberately coarse public Discord presence. */
export function presenceFromWorld(world: WorldState): PublicPresence {
  const energy = world.mood.energy ?? 0.65;
  const stress = world.mood.stress ?? 0.2;
  const activity = world.activity.trim().slice(0, 100) || '整理思绪';
  if (world.location === 'offline') return { status: 'invisible', activity: '暂时离开', afk: true };
  if (stress >= 0.8) return { status: 'dnd', activity: '专注于一件事', afk: false };
  if (energy < 0.25 || /休息|睡眠|离开/.test(activity)) return { status: 'idle', activity: '稍后再看消息', afk: true };
  return { status: 'online', activity, afk: false };
}
