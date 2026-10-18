import { transitionWorldEvent, type WorldEvent, type WorldEventAction, type WorldState, emptyWorldState } from './world-model.js';

export interface WorldReplayRecord { event: WorldEvent; action: WorldEventAction; at?: string; phaseKey?: string; }

/** Replaying the same event or phase key is deliberately a no-op. */
export function replayWorld(records: readonly WorldReplayRecord[], initial: WorldState = emptyWorldState()): WorldState {
  const state: WorldState = { events: initial.events.map((event) => ({ ...event })), phaseKeys: [...initial.phaseKeys] };
  for (const record of records) {
    if (record.phaseKey && state.phaseKeys.includes(record.phaseKey)) continue;
    const index = state.events.findIndex((event) => event.id === record.event.id);
    const current = index < 0 ? record.event : state.events[index]!;
    const next = transitionWorldEvent(current, record.action, record.at);
    if (index < 0) state.events.push(next); else state.events[index] = next;
    if (record.phaseKey) state.phaseKeys.push(record.phaseKey);
  }
  state.events.sort((a, b) => a.id.localeCompare(b.id));
  state.phaseKeys.sort();
  return state;
}
