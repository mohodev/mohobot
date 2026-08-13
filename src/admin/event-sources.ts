import type { EventEvidence, EventCandidate } from './event-intelligence.js';
import { mergeEventCandidate } from './event-intelligence.js';
import type { ScheduledEventKind } from './world-events.js';

export interface PublicEventSource { name: string; kind: EventEvidence['kind']; officialHosts: string[]; url: string; }
export const DEFAULT_PUBLIC_SOURCES: PublicEventSource[] = [
  { name: 'official-calendar', kind: 'official', officialHosts: [], url: '' },
  { name: 'ticketing-calendar', kind: 'ticketing', officialHosts: [], url: '' },
];

/** Large public events use sources; ordinary life never goes through search. */
export function shouldCollectExternally(kind: ScheduledEventKind): boolean {
  return kind === 'concert' || kind === 'rehearsal' || kind === 'news';
}

export function collectCandidate(input: { kind: ScheduledEventKind; title: string; startsAt: string; endsAt: string; location: string }, evidence: EventEvidence[], existing?: EventCandidate): EventCandidate {
  if (!shouldCollectExternally(input.kind)) throw new Error('daily-life events must be generated locally');
  return mergeEventCandidate(input, evidence, existing);
}

export function officialSourceEvidence(url: string, source: string): EventEvidence {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('source must be http(s)');
  return { url: parsed.toString(), source, kind: 'official', observedAt: new Date().toISOString() };
}
