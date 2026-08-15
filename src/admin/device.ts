import path from 'node:path';
import { TtlCache } from '../core/ttl-cache.js';
import { VersionedJsonStore } from '../core/versioned-json.js';

export type NetworkState = 'wifi' | 'cellular' | 'weak' | 'offline';
export type DeviceActivity = 'idle' | 'browsing' | 'chatting' | 'gaming' | 'sleeping' | 'charging';
export interface DeviceHabits { checksPhoneWhileCharging: boolean; chargeBelow: number; ignoresNotificationsWhile: DeviceActivity[]; delayedReplyProbability: number; }
export interface DeviceState { battery: number; charging: boolean; network: NetworkState; screen: 'on' | 'off'; doNotDisturb: boolean; activity: DeviceActivity; lastSeenAt: string; notificationCount: number; habits: DeviceHabits; }

const DEFAULT: DeviceState = { battery: 72, charging: false, network: 'wifi', screen: 'on', doNotDisturb: false, activity: 'idle', lastSeenAt: new Date().toISOString(), notificationCount: 0, habits: { checksPhoneWhileCharging: false, chargeBelow: 18, ignoresNotificationsWhile: ['sleeping'], delayedReplyProbability: .22 } };
function clamp(n: number): number { return Math.max(0, Math.min(100, Math.round(n))); }
function normalizeDevice(value: unknown): DeviceState {
  const row = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Partial<DeviceState>;
  return { ...DEFAULT, ...row, habits: { ...DEFAULT.habits, ...(row.habits ?? {}), ignoresNotificationsWhile: [...(row.habits?.ignoresNotificationsWhile ?? DEFAULT.habits.ignoresNotificationsWhile)] }, battery: clamp(typeof row.battery === 'number' ? row.battery : DEFAULT.battery) };
}

export class DeviceStore {
  readonly #store: VersionedJsonStore<DeviceState>;
  readonly #cache = new TtlCache<DeviceState>(2_000);
  constructor(rootDir: string, botId?: string) { const file = botId ? path.join(rootDir, 'data', 'bots', botId, 'world', 'device.json') : path.join(rootDir, 'data', 'world', 'device.json'); this.#store = new VersionedJsonStore({ file, defaultValue: () => structuredClone(DEFAULT), normalize: normalizeDevice }); }
  async get(): Promise<DeviceState> { const cached = this.#cache.get(); if (cached) return structuredClone(cached); const value = await this.#store.get(); this.#cache.set(value); return structuredClone(value); }
  async save(state: DeviceState): Promise<void> { const saved = await this.#store.save(state); this.#cache.set(saved.data); }
  async transition(patch: Partial<DeviceState>): Promise<DeviceState> {
    const saved = await this.#store.update((state) => { const next = { ...state, ...patch, habits: { ...state.habits, ...(patch.habits ?? {}) }, battery: clamp(patch.battery ?? state.battery), lastSeenAt: new Date().toISOString() }; if (next.charging) next.activity = 'charging'; return next; });
    this.#cache.set(saved.data); return structuredClone(saved.data);
  }
  shouldDelay(state: DeviceState): boolean { return state.doNotDisturb || state.network === 'offline' || (state.charging && !state.habits.checksPhoneWhileCharging) || state.habits.ignoresNotificationsWhile.includes(state.activity); }
}
