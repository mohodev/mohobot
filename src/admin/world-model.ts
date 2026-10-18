import { payloadHash, stableWorldId, type WorldEventStatus, type WorldSourceKind, type WorldTimeInterval } from './world-events.js';

export interface WorldEventPayload { [key: string]: unknown; }
export interface WorldEvent {
  id: string; sourceKind: WorldSourceKind; sourceId: string; trust: 'candidate' | 'confirmed' | 'rejected';
  time: WorldTimeInterval; scope: string; payload: WorldEventPayload; payloadHash: string;
  phase: string; appliedAt?: string; status: WorldEventStatus;
}
export interface WorldState { events: WorldEvent[]; phaseKeys: string[]; }
export type WorldEventAction = 'confirm' | 'activate' | 'apply-phase' | 'complete' | 'reject' | 'expire';

export function createWorldEvent(input: Omit<Partial<WorldEvent>, 'id' | 'payloadHash' | 'status'> & Pick<WorldEvent, 'sourceKind' | 'sourceId' | 'time' | 'scope' | 'payload' | 'phase'>): WorldEvent {
  const base = { sourceKind: input.sourceKind, sourceId: input.sourceId, time: input.time, scope: input.scope, payload: input.payload, phase: input.phase };
  return { ...base, id: stableWorldId(base), payloadHash: payloadHash(input.payload), trust: input.trust ?? 'candidate', status: input.trust ?? 'candidate', appliedAt: input.appliedAt };
}

export function transitionWorldEvent(event: WorldEvent, action: WorldEventAction, appliedAt?: string): WorldEvent {
  const time = appliedAt ?? new Date(0).toISOString();
  if (action === 'confirm' && event.status === 'candidate') return { ...event, trust: 'confirmed', status: 'confirmed' };
  if (action === 'reject' && !['completed', 'expired'].includes(event.status)) return { ...event, trust: 'rejected', status: 'rejected' };
  if (action === 'activate' && event.status === 'confirmed') return { ...event, status: 'active' };
  if (action === 'apply-phase' && ['active', 'confirmed'].includes(event.status)) return { ...event, status: 'phase-applied', appliedAt: time };
  if (action === 'complete' && ['active', 'phase-applied'].includes(event.status)) return { ...event, status: 'completed' };
  if (action === 'expire' && ['candidate', 'confirmed', 'active', 'phase-applied'].includes(event.status)) return { ...event, status: 'expired' };
  if (action === 'apply-phase' && event.status === 'phase-applied') return event;
  throw new Error(`invalid world event transition: ${event.status} -> ${action}`);
}

export function emptyWorldState(): WorldState { return { events: [], phaseKeys: [] }; }
