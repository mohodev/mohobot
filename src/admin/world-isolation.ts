export type WorldDomainStrategy = 'shared' | 'per-bot' | 'per-channel';

export interface WorldDomain {
  id: string;
  botId: string;
  channelId?: string;
  strategy: WorldDomainStrategy;
  createdAt: string;
}

export interface WorldTraceEntry {
  id: string;
  domainId: string;
  botId: string;
  at: string;
  kind: 'tick' | 'event' | 'schedule' | 'evolution' | 'daily-life';
  phaseKey?: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  detail?: string;
}

const DEFAULT_STRATEGY: WorldDomainStrategy = 'shared';
const SHARED_DOMAIN_ID = 'world:shared';

const domains = new Map<string, WorldDomain>();
const traces: WorldTraceEntry[] = [];
const MAX_TRACES = 2000;

function domainKey(botId: string, channelId?: string, strategy?: WorldDomainStrategy): string {
  const s = strategy ?? DEFAULT_STRATEGY;
  if (s === 'shared') return SHARED_DOMAIN_ID;
  if (s === 'per-channel' && channelId) return `world:${botId}:${channelId}`;
  return `world:${botId}`;
}

/**
 * Resolve the world domain for a bot (and optionally a channel).
 * The default strategy is 'shared' — all bots share one world.
 */
export function getWorldForBot(botId: string, channelId?: string, strategy?: WorldDomainStrategy): WorldDomain {
  const s = strategy ?? DEFAULT_STRATEGY;
  const id = domainKey(botId, channelId, s);
  const existing = domains.get(id);
  if (existing) return existing;
  const domain: WorldDomain = { id, botId, channelId, strategy: s, createdAt: new Date().toISOString() };
  domains.set(id, domain);
  return domain;
}

export function listDomains(): WorldDomain[] {
  return [...domains.values()];
}

export function recordTrace(entry: Omit<WorldTraceEntry, 'id'>): WorldTraceEntry {
  const record: WorldTraceEntry = { ...entry, id: `trace:${globalThis.crypto.randomUUID()}` };
  traces.push(record);
  if (traces.length > MAX_TRACES) traces.splice(0, traces.length - MAX_TRACES);
  return record;
}

export function queryTraces(opts?: {
  domainId?: string;
  botId?: string;
  kind?: WorldTraceEntry['kind'];
  limit?: number;
}): WorldTraceEntry[] {
  let result = traces;
  if (opts?.domainId) result = result.filter((t) => t.domainId === opts.domainId);
  if (opts?.botId) result = result.filter((t) => t.botId === opts.botId);
  if (opts?.kind) result = result.filter((t) => t.kind === opts.kind);
  const limit = opts?.limit ?? 100;
  return result.slice(-limit);
}

/** Reset all in-memory domains and traces (for testing). */
export function resetIsolation(): void {
  domains.clear();
  traces.length = 0;
}
