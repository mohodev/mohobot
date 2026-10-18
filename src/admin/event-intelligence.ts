import type { ScheduledWorldEvent } from './world-events.js';
import { validateScheduledEvent } from './world-events.js';

export interface EventEvidence {
  url: string;
  source: string;
  /** official = artist/promoter/venue; ticketing = known ticket vendor; news = editorial report. */
  kind: 'official' | 'ticketing' | 'news' | 'search';
  observedAt: string;
}

export interface EventCandidate extends ScheduledWorldEvent {
  confidence: number;
  evidence: EventEvidence[];
  fingerprint: string;
  sourceChain: string[];
  expiresAt: string;
}

export interface RelationshipCandidate {
  id: string;
  kind: 'relationship';
  subject: string;
  object: string;
  relation: string;
  confidence: number;
  sourceChain: EventEvidence[];
  expiresAt: string;
  trust: 'candidate';
}

function normalize(value: string): string { return value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ''); }
export function eventFingerprint(event: Pick<ScheduledWorldEvent, 'kind'|'title'|'location'|'startsAt'>): string {
  return [event.kind, normalize(event.title), normalize(event.location), event.startsAt.slice(0, 10)].join(':');
}

export function scoreEvidence(evidence: EventEvidence[]): number {
  const unique = new Map(evidence.map((item) => [new URL(item.url).hostname, item]));
  let score = 0;
  for (const item of unique.values()) score += item.kind === 'official' ? .65 : item.kind === 'ticketing' ? .35 : item.kind === 'news' ? .25 : .1;
  return Math.min(1, Math.round(score * 100) / 100);
}

/** Merge normalized collector output. No network fetching occurs in this trust boundary. */
export function mergeEventCandidate(input: Partial<ScheduledWorldEvent>, evidence: EventEvidence[], existing?: EventCandidate): EventCandidate {
  const validated = validateScheduledEvent({ ...input, trust: 'candidate' });
  const mergedEvidence = [...(existing?.evidence ?? []), ...evidence].filter((item, index, all) => all.findIndex((other) => other.url === item.url) === index);
  for (const item of mergedEvidence) { const parsed = new URL(item.url); if (!['http:','https:'].includes(parsed.protocol)) throw new Error('invalid evidence URL'); }
  return { ...validated, id: existing?.id ?? validated.id, confidence: scoreEvidence(mergedEvidence), evidence: mergedEvidence, fingerprint: eventFingerprint(validated), sourceChain: mergedEvidence.map((item) => item.url), expiresAt: new Date(Math.min(Date.parse(validated.endsAt), Date.now() + 30 * 24 * 60 * 60 * 1000)).toISOString() };
}

export function mayAutoConfirm(candidate: EventCandidate): boolean {
  const hasOfficial = candidate.evidence.some((item) => item.kind === 'official');
  const independentHosts = new Set(candidate.evidence.map((item) => new URL(item.url).hostname)).size;
  return hasOfficial && independentHosts >= 2 && candidate.confidence >= .85 && Date.parse(candidate.endsAt) > Date.now();
}

/** Relationship changes use the same evidence gate and always enter the schedule as candidates. */
export function mergeRelationshipCandidate(input: { id?: string; subject: string; object: string; relation: string; expiresAt?: string }, evidence: EventEvidence[]): RelationshipCandidate {
  const sources = evidence.filter((item, index, all) => all.findIndex((other) => other.url === item.url) === index);
  for (const item of sources) { const parsed = new URL(item.url); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid evidence URL'); }
  const confidence = scoreEvidence(sources);
  return { id: input.id ?? `relationship:${normalize(input.subject)}:${normalize(input.object)}:${normalize(input.relation)}`, kind: 'relationship', subject: input.subject.trim(), object: input.object.trim(), relation: input.relation.trim(), confidence, sourceChain: sources, expiresAt: input.expiresAt ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), trust: 'candidate' };
}
