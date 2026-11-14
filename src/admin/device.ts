import fs from 'node:fs/promises';
import path from 'node:path';
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
  readonly #snapshots = new WeakMap<DeviceState, unknown>();
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

  /** Every read reaches SQLite; the returned object is tracked as a CAS snapshot. */
  async get(): Promise<DeviceState> {
    await this.#init();
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const current = await this.#storage.get<DeviceState>(this.#key);
      if (current !== undefined) {
        const snapshot = structuredClone(normalizeDevice(current));
        this.#snapshots.set(snapshot, current);
        return snapshot;
      }
      const legacy = await readLegacy(this.#legacyFile);
      const initial = normalizeDevice(legacy ?? structuredClone(DEFAULT));
      if (await this.#compareAndSet(undefined, initial)) continue;
    }
    throw new Error('device state initialization did not converge');
  }

  /** Reject stale snapshots rather than overwriting another Runtime's update. */
  async save(state: DeviceState): Promise<void> {
    await this.#init();
    const expected = this.#snapshots.get(state);
    if (expected === undefined) throw new Error('DeviceStore.save requires a snapshot returned by get()');
    const next = normalizeDevice(state);
    if (!await this.#compareAndSet(expected, next)) {
      throw new Error('device state changed in another runtime; refusing to overwrite a stale snapshot');
    }
    const snapshot = structuredClone(next);
    this.#snapshots.set(snapshot, next);
  }

  /** Apply patches against the latest DB value and retry concurrent writers. */
  async transition(patch: Partial<DeviceState>): Promise<DeviceState> {
    await this.#init();
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const current = await this.#storage.get<DeviceState>(this.#key);
      if (current === undefined) {
        await this.get();
        continue;
      }
      const state = normalizeDevice(current);
      const next = normalizeDevice({
        ...state,
        ...patch,
        habits: { ...state.habits, ...(patch.habits ?? {}) },
        battery: clamp(patch.battery ?? state.battery),
        lastSeenAt: new Date().toISOString(),
      });
      if (next.charging) next.activity = 'charging';
      if (await this.#compareAndSet(current, next)) {
        const snapshot = structuredClone(next);
        this.#snapshots.set(snapshot, next);
        return snapshot;
      }
    }
    throw new Error('device state update contention exceeded retry limit');
  }

  async close(): Promise<void> { await this.#storage.close(); }

  #compareAndSet(expected: unknown, value: DeviceState): Promise<boolean> {
    if (!this.#storage.compareAndSet) throw new Error('DeviceStore requires a storage driver with compareAndSet support');
    return this.#storage.compareAndSet(this.#key, expected, value);
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
