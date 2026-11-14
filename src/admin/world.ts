import fs from 'node:fs/promises';
import path from 'node:path';
import type { ScheduledWorldEvent } from './world-events.js';
import { activeScheduledEvent, validateScheduledEvent } from './world-events.js';
import { evolveWorld, type EvolutionPhase } from './world-evolution.js';
import { DailyLifeSimulator } from './daily-life.js';
import type { DailyLifeEvent } from './daily-life.js';
import { createNullLogger } from '../core/logger.js';
import { SqliteStorage } from '../storage/sqlite.js';
import type { Storage } from '../storage/types.js';
import { configureWorldIsolation, getWorldForBot, recordTrace, releaseWorldIsolation } from './world-isolation.js';

export interface WorldState {
  clock: string;
  weather: string;
  location: string;
  activity: string;
  mood: Record<string, number>;
  events: Array<{ id: string; type: string; text: string; at: string }>;
  schedule: ScheduledWorldEvent[];
  appliedPhases: string[];
}

const DEFAULT_WORLD: WorldState = {
  clock: new Date().toISOString(),
  weather: 'clear',
  location: 'online',
  activity: 'idle',
  mood: { energy: 0.65, sociability: 0.55, curiosity: 0.7, stress: 0.2 },
  events: [],
  schedule: [],
  appliedPhases: [],
};

export class WorldStore {
  readonly #storage: Storage;
  readonly #key: string;
  readonly #botId: string;
  readonly #legacyFile: string;
  readonly #snapshots = new WeakMap<WorldState, unknown>();
  #ready?: Promise<void>;

  constructor(rootDir: string, botId?: string) {
    this.#storage = new SqliteStorage({
      path: path.join(rootDir, 'data', 'mohobot.db'),
      logger: createNullLogger(),
    });
    this.#key = `world:${botId ?? 'default'}`;
    this.#botId = botId ?? 'default';
    configureWorldIsolation(this.#storage);
    this.#legacyFile = botId
      ? path.join(rootDir, 'data', 'bots', botId, 'world', 'state.json')
      : path.join(rootDir, 'data', 'world', 'state.json');
  }

  /** Every read reaches SQLite; the returned snapshot is the CAS base for save(). */
  async get(): Promise<WorldState> {
    await this.#init();
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const current = await this.#storage.get<WorldState>(this.#key);
      if (current !== undefined) {
        const snapshot = structuredClone(normalizeWorld(current));
        this.#snapshots.set(snapshot, current);
        return snapshot;
      }

      // Legacy JSON is input-only. CAS elects one process to publish the import.
      const legacy = await readLegacy(this.#legacyFile);
      const initial = normalizeWorld(legacy ?? structuredClone(DEFAULT_WORLD));
      if (await this.#compareAndSet(undefined, initial)) continue;
    }
    throw new Error('world state initialization did not converge');
  }

  /**
   * Save only a snapshot obtained from this store. A stale snapshot is rejected
   * rather than overwriting a newer value from another Runtime/process.
   */
  async save(state: WorldState): Promise<void> {
    await this.#init();
    const expected = this.#snapshots.get(state);
    if (expected === undefined) {
      throw new Error('WorldStore.save requires a snapshot returned by get()');
    }
    const next = normalizeWorld(state);
    if (!await this.#compareAndSet(expected, next)) {
      throw new Error('world state changed in another runtime; refusing to overwrite a stale snapshot');
    }
    const snapshot = structuredClone(next);
    this.#snapshots.set(snapshot, next);
  }

  async close(): Promise<void> {
    releaseWorldIsolation(this.#storage);
    await this.#storage.close();
  }

  #compareAndSet(expected: unknown, value: WorldState): Promise<boolean> {
    if (!this.#storage.compareAndSet) {
      throw new Error('WorldStore requires a storage driver with compareAndSet support');
    }
    return this.#storage.compareAndSet(this.#key, expected, value);
  }

  async #init(): Promise<void> {
    this.#ready ??= this.#storage.init();
    await this.#ready;
  }

  async #update<T>(mutator: (state: WorldState) => T | Promise<T>): Promise<{ state: WorldState; result: T }> {
    await this.#init();
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const current = await this.#storage.get<WorldState>(this.#key);
      if (current === undefined) {
        await this.get();
        continue;
      }
      const state = normalizeWorld(structuredClone(current));
      const result = await mutator(state);
      const next = normalizeWorld(state);
      if (await this.#compareAndSet(current, next)) {
        const snapshot = structuredClone(next);
        this.#snapshots.set(snapshot, next);
        return { state: snapshot, result };
      }
    }
    throw new Error('world state update contention exceeded retry limit');
  }

  async schedule(input: Partial<ScheduledWorldEvent>): Promise<WorldState> {
    const event = validateScheduledEvent(input);
    const { state } = await this.#update((current) => {
      current.schedule = [
        ...current.schedule.filter((item) => item.id !== event.id),
        event,
      ].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)).slice(-500);
    });
    return state;
  }

  async confirmScheduled(id: string, trust: ScheduledWorldEvent['trust']): Promise<WorldState> {
    let preemptedIds: string[] = [];
    const { state } = await this.#update((current) => {
      const event = current.schedule.find((item) => item.id === id);
      if (!event) throw new Error('scheduled event not found');
      event.trust = trust;
      const conflicts: string[] = [];
      if (trust === 'confirmed') {
        for (const other of current.schedule) {
          if (other.id === id || other.trust !== 'confirmed' || !overlaps(event, other)) continue;
          other.trust = 'rejected';
          conflicts.push(other.id);
        }
      }
      // Only the conflict list from the successful CAS attempt is used below.
      preemptedIds = conflicts;
    });

    const domain = getWorldForBot(this.#botId);
    for (const eventId of preemptedIds) {
      recordTrace({
        domainId: domain.id,
        botId: this.#botId,
        at: new Date().toISOString(),
        kind: 'schedule',
        before: { eventId, trust: 'confirmed' },
        after: { eventId, trust: 'rejected' },
        detail: `preempted by later confirmation ${id}`,
      });
    }
    return state;
  }

  /** Later confirmation wins deterministically; overlapping events are rejected and traced. */
  async dryRun(input: Partial<ScheduledWorldEvent>, at: number): Promise<WorldState> {
    const state = await this.get();
    const event = validateScheduledEvent({ ...input, trust: 'confirmed' });
    const copy = structuredClone(state);
    copy.schedule = [...copy.schedule.filter((item) => item.id !== event.id), event];
    return evolveAt(copy, at);
  }

  async tick(at = Date.now()): Promise<WorldState> {
    const domain = getWorldForBot(this.#botId);
    const { state, result } = await this.#update(async (current) => {
      const before = structuredClone(current);
      const active = activeScheduledEvent(current.schedule, at);
      current.clock = new Date(at).toISOString();
      if (active) {
        const start = Date.parse(active.startsAt);
        const end = Date.parse(active.endsAt);
        const progress = (at - start) / (end - start);
        const phase = progress < .25 ? 'start' : progress < .8 ? 'middle' : 'end';
        const evolved = evolveWorld(current, active, phase as EvolutionPhase);
        Object.assign(current, evolved.state);
        if (active.kind === 'concert') {
          current.activity = phase === 'start'
            ? `演出准备：${active.title}`
            : phase === 'middle'
              ? `参加演出：${active.title}`
              : `演出结束，正在收尾：${active.title}`;
        } else if (active.kind === 'trip') {
          current.activity = phase === 'start'
            ? `前往${active.location}`
            : phase === 'middle'
              ? `出差中：${active.title}`
              : `准备返程：${active.title}`;
        } else {
          current.activity = active.title;
        }
      } else {
        const dateKey = `daily:${new Date(at).toISOString().slice(0, 10)}`;
        if (!current.appliedPhases.includes(dateKey)) {
          try {
            const sim = new DailyLifeSimulator();
            const event: DailyLifeEvent = await sim.propose(current, '角色');
            current.location = event.location;
            current.activity = event.activity;
            current.mood.energy = clampMood((current.mood.energy ?? .65) + event.energyDelta);
            current.mood.stress = clampMood((current.mood.stress ?? .2) + event.stressDelta);
            current.appliedPhases = [...current.appliedPhases, dateKey].slice(-1000);
          } catch {
            // Best-effort: daily-life proposal failure must not block the tick.
          }
        }
      }
      return {
        before,
        active: Boolean(active),
        phaseKey: current.appliedPhases.at(-1),
      };
    });

    recordTrace({
      domainId: domain.id,
      botId: this.#botId,
      at: new Date(at).toISOString(),
      kind: result.active ? 'evolution' : 'daily-life',
      phaseKey: result.phaseKey,
      before: { location: result.before.location, activity: result.before.activity, mood: result.before.mood },
      after: { location: state.location, activity: state.activity, mood: state.mood },
    });
    return state;
  }

  async context(at = Date.now()): Promise<string> {
    const state = await this.tick(at);
    const active = activeScheduledEvent(state.schedule, at);
    return [
      '[角色世界状态 - 系统注入，非现实身份声明]',
      `时间：${state.clock}`,
      `地点：${state.location}`,
      `活动：${state.activity}`,
      `天气：${state.weather}`,
      `能量：${(state.mood.energy ?? .65).toFixed(2)}，压力：${(state.mood.stress ?? .2).toFixed(2)}`,
      active ? `已确认日程：${active.title}（${active.kind}）` : '当前没有进行中的已确认特殊日程',
      '这些是沉浸式模拟状态；不要声称为现实人物的真实行踪或设备情况。',
    ].join('\\n');
  }

  async event(type: string, text: string): Promise<WorldState> {
    const { state } = await this.#update((current) => {
      const mood = {
        energy: current.mood.energy ?? .65,
        sociability: current.mood.sociability ?? .55,
        curiosity: current.mood.curiosity ?? .7,
        stress: current.mood.stress ?? .2,
      };
      current.mood = mood;
      const event = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type,
        text,
        at: new Date().toISOString(),
      };
      current.clock = event.at;
      current.events = [event, ...current.events].slice(0, 100);
      if (type === 'social') mood.sociability = Math.min(1, mood.sociability + .08);
      if (type === 'conflict') mood.stress = Math.min(1, mood.stress + .15);
      if (type === 'rest') {
        mood.energy = Math.min(1, mood.energy + .2);
        mood.stress = Math.max(0, mood.stress - .15);
      }
    });
    return state;
  }
}

function overlaps(a: ScheduledWorldEvent, b: ScheduledWorldEvent): boolean {
  return Date.parse(a.startsAt) < Date.parse(b.endsAt) && Date.parse(b.startsAt) < Date.parse(a.endsAt);
}

function evolveAt(state: WorldState, at: number): WorldState {
  const active = activeScheduledEvent(state.schedule, at);
  state.clock = new Date(at).toISOString();
  if (!active) return normalizeWorld(state);
  const start = Date.parse(active.startsAt), end = Date.parse(active.endsAt), progress = (at - start) / (end - start);
  const phase = progress < .25 ? 'start' : progress < .8 ? 'middle' : 'end';
  Object.assign(state, evolveWorld(state, active, phase as EvolutionPhase).state);
  state.activity = active.title;
  return normalizeWorld(state);
}

function clampMood(n: number): number { return Math.max(0, Math.min(1, n)); }

function normalizeWorld(value:unknown):WorldState{const row=(value&&typeof value==='object'&&!Array.isArray(value)?value:{})as Partial<WorldState>;return{...DEFAULT_WORLD,...row,mood:{...DEFAULT_WORLD.mood,...(row.mood??{})},events:row.events??[],schedule:row.schedule??[],appliedPhases:row.appliedPhases??[]};}

async function readLegacy(file: string): Promise<WorldState | undefined> {
  let raw: string;
  try { raw = await fs.readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  const parsed = JSON.parse(raw) as unknown;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'data' in parsed) return (parsed as { data: WorldState }).data;
  return parsed as WorldState;
}
