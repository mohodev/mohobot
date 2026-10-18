import { createHash } from 'node:crypto';

export type ScheduledEventKind = 'trip' | 'concert' | 'rehearsal' | 'rest' | 'news';
export type EventTrust = 'candidate' | 'confirmed' | 'rejected';
export type WorldSourceKind = 'calendar' | 'daily-life' | 'external' | 'internal' | 'manual';
export type WorldEventStatus = EventTrust | 'active' | 'phase-applied' | 'completed' | 'expired';
export interface WorldTimeInterval { start: string; end: string; timezone?: string; }

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  throw new Error('unsupported world payload');
}

export function payloadHash(payload: unknown): string { return createHash('sha256').update(canonical(payload)).digest('hex'); }
export function stableWorldId(input: { sourceKind: WorldSourceKind; sourceId: string; time: WorldTimeInterval; scope: string; payload: unknown; phase: string }): string {
  return `world:${createHash('sha256').update(canonical(input)).digest('hex').slice(0, 32)}`;
}
export interface ScheduledWorldEvent {
  id: string; kind: ScheduledEventKind; title: string; startsAt: string; endsAt: string;
  location: string; timezone: string; sourceUrl?: string; sourceName?: string;
  trust: EventTrust; notes?: string; transport?: string; accommodation?: string;
}

export function validateScheduledEvent(input: Partial<ScheduledWorldEvent>): ScheduledWorldEvent {
  if (!input.kind || !['trip','concert','rehearsal','rest','news'].includes(input.kind)) throw new Error('invalid event kind');
  if (!input.title?.trim() || !input.location?.trim()) throw new Error('event title and location are required');
  const start = Date.parse(input.startsAt ?? ''), end = Date.parse(input.endsAt ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('invalid event time range');
  let sourceUrl: string | undefined;
  if (input.sourceUrl) { const parsed = new URL(input.sourceUrl); if (!['http:','https:'].includes(parsed.protocol)) throw new Error('invalid source URL'); sourceUrl = parsed.toString(); }
  return { id: input.id ?? `${start}-${Math.random().toString(36).slice(2,8)}`, kind: input.kind, title: input.title.trim(), startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(), location: input.location.trim(), timezone: input.timezone?.trim() || 'Asia/Shanghai', sourceUrl, sourceName: input.sourceName?.trim(), trust: input.trust ?? 'candidate', notes: input.notes?.trim(), transport: input.transport?.trim(), accommodation: input.accommodation?.trim() };
}

export function activeScheduledEvent(events: ScheduledWorldEvent[], at = Date.now()): ScheduledWorldEvent | undefined {
  return events.filter((e)=>e.trust==='confirmed' && Date.parse(e.startsAt)<=at && Date.parse(e.endsAt)>at).sort((a,b)=>Date.parse(b.startsAt)-Date.parse(a.startsAt))[0];
}
