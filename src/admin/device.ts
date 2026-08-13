import fs from 'node:fs/promises';
import path from 'node:path';
import { TtlCache } from '../core/ttl-cache.js';

export type NetworkState = 'wifi' | 'cellular' | 'weak' | 'offline';
export type DeviceActivity = 'idle' | 'browsing' | 'chatting' | 'gaming' | 'sleeping' | 'charging';
export interface DeviceHabits { checksPhoneWhileCharging: boolean; chargeBelow: number; ignoresNotificationsWhile: DeviceActivity[]; delayedReplyProbability: number; }
export interface DeviceState { battery: number; charging: boolean; network: NetworkState; screen: 'on' | 'off'; doNotDisturb: boolean; activity: DeviceActivity; lastSeenAt: string; notificationCount: number; habits: DeviceHabits; }

const DEFAULT: DeviceState = { battery: 72, charging: false, network: 'wifi', screen: 'on', doNotDisturb: false, activity: 'idle', lastSeenAt: new Date().toISOString(), notificationCount: 0, habits: { checksPhoneWhileCharging: false, chargeBelow: 18, ignoresNotificationsWhile: ['sleeping'], delayedReplyProbability: .22 } };
function clamp(n: number): number { return Math.max(0, Math.min(100, Math.round(n))); }

export class DeviceStore {
  readonly #file: string;
  readonly #cache = new TtlCache<DeviceState>(2_000);
  constructor(rootDir: string) { this.#file = path.join(rootDir, 'data', 'world', 'device.json'); }
  async get(): Promise<DeviceState> { const cached=this.#cache.get();if(cached)return cached;try { const value = JSON.parse(await fs.readFile(this.#file, 'utf8')) as Partial<DeviceState>; return this.#cache.set({ ...DEFAULT, ...value, habits: { ...DEFAULT.habits, ...(value.habits ?? {}) } }); } catch { await this.save(DEFAULT); return { ...DEFAULT, habits: { ...DEFAULT.habits, ignoresNotificationsWhile: [...DEFAULT.habits.ignoresNotificationsWhile] } }; } }
  async save(state: DeviceState): Promise<void> { this.#cache.set(state);await fs.mkdir(path.dirname(this.#file), { recursive: true }); await fs.writeFile(this.#file, JSON.stringify(state, null, 2) + '\n', 'utf8'); }
  async transition(patch: Partial<DeviceState>): Promise<DeviceState> { const state = await this.get(); const next = { ...state, ...patch, battery: clamp(patch.battery ?? state.battery), lastSeenAt: new Date().toISOString() }; if (next.charging) next.activity = 'charging'; await this.save(next); return next; }
  shouldDelay(state: DeviceState): boolean { return state.doNotDisturb || state.network === 'offline' || (state.charging && !state.habits.checksPhoneWhileCharging) || state.habits.ignoresNotificationsWhile.includes(state.activity); }
}
