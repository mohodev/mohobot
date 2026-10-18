import fs from 'node:fs/promises';
import path from 'node:path';
import { TtlCache } from '../core/ttl-cache.js';
import { createNullLogger } from '../core/logger.js';
import { SqliteStorage } from '../storage/sqlite.js';
import type { Storage } from '../storage/types.js';

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
  readonly #storage: Storage;
  readonly #key: string;
  readonly #legacyFile: string;
  readonly #cache = new TtlCache<DeviceState>(2_000);
  #ready?: Promise<void>;

  constructor(rootDir: string, botId?: string) {
    this.#storage = new SqliteStorage({
      path: path.join(rootDir, 'data', 'mohobot.db'),
      logger: createNullLogger(),
    });
    this.#key = `device:${botId ?? 'default'}`;
    this.#legacyFile = botId
      ? path.join(rootDir, 'data', 'bots', botId, 'world', 'device.json')
      : path.join(rootDir, 'data', 'world', 'device.json');
  }

  async get(): Promise<DeviceState> {
    const cached = this.#cache.get();
    if (cached) return structuredClone(cached);
    await this.#init();
    const current = await this.#storage.get<DeviceState>(this.#key);
    if (current !== undefined) {
      const value = normalizeDevice(current);
      this.#cache.set(value);
      return structuredClone(value);
    }
    const legacy = await readLegacy(this.#legacyFile);
    const value = normalizeDevice(legacy ?? structuredClone(DEFAULT));
    await this.#storage.save(this.#key, value);
    this.#cache.set(value);
    return structuredClone(value);
  }

  async save(state: DeviceState): Promise<void> {
    const normalized = normalizeDevice(state);
    await this.#init();
    await this.#storage.save(this.#key, normalized);
    this.#cache.set(normalized);
  }

  async transition(patch: Partial<DeviceState>): Promise<DeviceState> {
    const state = await this.get();
    const next = { ...state, ...patch, habits: { ...state.habits, ...(patch.habits ?? {}) }, battery: clamp(patch.battery ?? state.battery), lastSeenAt: new Date().toISOString() };
    if (next.charging) next.activity = 'charging';
    const normalized = normalizeDevice(next);
    await this.#init();
    await this.#storage.save(this.#key, normalized);
    this.#cache.set(normalized);
    return structuredClone(normalized);
  }

  shouldDelay(state: DeviceState): boolean { return state.doNotDisturb || state.network === 'offline' || (state.charging && !state.habits.checksPhoneWhileCharging) || state.habits.ignoresNotificationsWhile.includes(state.activity); }

  async #init(): Promise<void> {
    this.#ready ??= this.#storage.init();
    await this.#ready;
  }
}

async function readLegacy(file: string): Promise<DeviceState | undefined> {
  let raw: string;
  try { raw = await fs.readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  const parsed = JSON.parse(raw) as unknown;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'data' in parsed) return (parsed as { data: DeviceState }).data;
  return parsed as DeviceState;
}
