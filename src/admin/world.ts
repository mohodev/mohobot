import path from 'node:path';
import type { ScheduledWorldEvent } from './world-events.js';
import { activeScheduledEvent, validateScheduledEvent } from './world-events.js';
import { TtlCache } from '../core/ttl-cache.js';
import { VersionedJsonStore } from '../core/versioned-json.js';

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
  readonly #store: VersionedJsonStore<WorldState>;
  readonly #cache = new TtlCache<WorldState>(2_000);
  constructor(rootDir: string) {
    this.#store = new VersionedJsonStore({ file: path.join(rootDir, 'data', 'world', 'state.json'), defaultValue: () => structuredClone(DEFAULT_WORLD), normalize: normalizeWorld });
  }

  async get(): Promise<WorldState> { const cached=this.#cache.get();if(cached)return structuredClone(cached);const value=await this.#store.get();this.#cache.set(value);return structuredClone(value); }

  async save(state: WorldState): Promise<void> { const saved=await this.#store.save(state);this.#cache.set(saved.data); }

  async #update(mutator: (state: WorldState) => void): Promise<WorldState> { const saved=await this.#store.update((state)=>{mutator(state);return state;});this.#cache.set(saved.data);return structuredClone(saved.data); }

  async schedule(input: Partial<ScheduledWorldEvent>): Promise<WorldState> { const event=validateScheduledEvent(input);return this.#update((state)=>{state.schedule=[...state.schedule.filter((item)=>item.id!==event.id),event].sort((a,b)=>Date.parse(a.startsAt)-Date.parse(b.startsAt)).slice(-500);}); }

  async confirmScheduled(id: string, trust: ScheduledWorldEvent['trust']): Promise<WorldState> { return this.#update((state)=>{const event=state.schedule.find((item)=>item.id===id);if(!event)throw new Error('scheduled event not found');event.trust=trust;}); }

  async tick(at = Date.now()): Promise<WorldState> {
    return this.#update((state)=>{
    const active = activeScheduledEvent(state.schedule, at);
    state.clock = new Date(at).toISOString();
    if (!active) return;
    const start = Date.parse(active.startsAt), end = Date.parse(active.endsAt), progress = (at-start)/(end-start);
    state.location = active.location;
    const phase = progress < .25 ? 'start' : progress < .8 ? 'middle' : 'end';
    const phaseKey = `${active.id}:${phase}`;
    const firstInPhase = !state.appliedPhases.includes(phaseKey);
    if (active.kind === 'concert') {
      state.activity = phase === 'start' ? `演出准备：${active.title}` : phase === 'middle' ? `参加演出：${active.title}` : `演出结束，正在收尾：${active.title}`;
      if (firstInPhase) { state.mood.energy = Math.max(0, (state.mood.energy ?? .65) - (phase === 'end' ? .08 : .12)); state.mood.stress = Math.max(0, Math.min(1, (state.mood.stress ?? .2) + (phase === 'start' ? .08 : -.03))); }
    } else if (active.kind === 'trip') {
      state.activity = phase === 'start' ? `前往${active.location}` : phase === 'middle' ? `出差中：${active.title}` : `准备返程：${active.title}`;
      if (firstInPhase) state.mood.energy = Math.max(0, (state.mood.energy ?? .65)-.05);
    } else state.activity = active.title;
    if (firstInPhase) state.appliedPhases = [...state.appliedPhases, phaseKey].slice(-1000);
    });
  }

  async context(at = Date.now()): Promise<string> {
    const state = await this.tick(at);
    const active = activeScheduledEvent(state.schedule, at);
    return ['[角色世界状态 - 系统注入，非现实身份声明]', `时间：${state.clock}`, `地点：${state.location}`, `活动：${state.activity}`, `天气：${state.weather}`, `能量：${(state.mood.energy ?? .65).toFixed(2)}，压力：${(state.mood.stress ?? .2).toFixed(2)}`, active ? `已确认日程：${active.title}（${active.kind}）` : '当前没有进行中的已确认特殊日程', '这些是沉浸式模拟状态；不要声称为现实人物的真实行踪或设备情况。'].join('\n');
  }

  async event(type: string, text: string): Promise<WorldState> { return this.#update((state)=>{
    const mood={energy:state.mood.energy??0.65,sociability:state.mood.sociability??0.55,curiosity:state.mood.curiosity??0.7,stress:state.mood.stress??0.2};state.mood=mood;
    const event={id:`${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,type,text,at:new Date().toISOString()};state.clock=event.at;state.events=[event,...state.events].slice(0,100);
    if(type==='social')mood.sociability=Math.min(1,mood.sociability+0.08);if(type==='conflict')mood.stress=Math.min(1,mood.stress+0.15);if(type==='rest'){mood.energy=Math.min(1,mood.energy+0.2);mood.stress=Math.max(0,mood.stress-0.15);}
  }); }
}

function normalizeWorld(value:unknown):WorldState{const row=(value&&typeof value==='object'&&!Array.isArray(value)?value:{})as Partial<WorldState>;return{...DEFAULT_WORLD,...row,mood:{...DEFAULT_WORLD.mood,...(row.mood??{})},events:row.events??[],schedule:row.schedule??[],appliedPhases:row.appliedPhases??[]};}
