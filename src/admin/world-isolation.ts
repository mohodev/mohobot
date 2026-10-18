import type { Storage } from '../storage/types.js';

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
let persistentStorage: Storage | undefined;
let storageReady: Promise<void> | undefined;
let pendingWrites: Promise<void> = Promise.resolve();

export function configureWorldIsolation(storage: Storage): void {
  persistentStorage = storage;
  storageReady = storage.init();
}

/** Release the persistent sink if it is the given storage (e.g. on close). */
export function releaseWorldIsolation(storage: Storage): void {
  if (persistentStorage !== storage) return;
  persistentStorage = undefined;
  storageReady = undefined;
}

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
  if (persistentStorage) void persistDomain(domain);
  return domain;
}

async function persistDomain(domain: WorldDomain): Promise<void> {
  try {
    await storageReady;
    await persistentStorage?.save(`world-domain:${domain.id}`, domain);
  } catch { /* trace/domain persistence is best-effort observability */ }
}

export function listDomains(): WorldDomain[] {
  return [...domains.values()];
}

export function recordTrace(entry: Omit<WorldTraceEntry, 'id'>): WorldTraceEntry {
  const record: WorldTraceEntry = { ...entry, id: `trace:${globalThis.crypto.randomUUID()}` };
  traces.push(record);
  if (traces.length > MAX_TRACES) traces.splice(0, traces.length - MAX_TRACES);
  if (persistentStorage) pendingWrites = pendingWrites.then(() => persistTrace(record)).catch(() => {});
  return record;
}

async function persistTrace(record: WorldTraceEntry): Promise<void> {
  const storage = persistentStorage;
  if (!storage) return;
  try {
    await storageReady;
    await storage.save(`world-trace:${record.id}`, record);
    const rows = await storage.query<WorldTraceEntry>({ prefix: 'world-trace:', limit: MAX_TRACES + 1 });
    for (const row of rows.slice(MAX_TRACES)) await storage.delete(row.key);
  } catch { /* trace persistence is best-effort observability */ }
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

export async function queryPersistentTraces(opts?: Parameters<typeof queryTraces>[0]): Promise<WorldTraceEntry[]> {
  const storage = persistentStorage;
  if (!storage) return queryTraces(opts);
  await storageReady;
  await pendingWrites;
  const rows = await storage.query<WorldTraceEntry>({ prefix: 'world-trace:', limit: MAX_TRACES });
  let result = rows.map((row) => row.value).sort((a, b) => a.at.localeCompare(b.at));
  if (opts?.domainId) result = result.filter((t) => t.domainId === opts.domainId);
  if (opts?.botId) result = result.filter((t) => t.botId === opts.botId);
  if (opts?.kind) result = result.filter((t) => t.kind === opts.kind);
  return result.slice(-(opts?.limit ?? 100));
}

export async function listPersistentDomains(): Promise<WorldDomain[]> {
  const storage = persistentStorage;
  if (!storage) return listDomains();
  await storageReady;
  const rows = await storage.query<WorldDomain>({ prefix: 'world-domain:', limit: 500 });
  return rows.map((row) => row.value);
}

/** Reset all in-memory domains and traces (for testing). */
export function resetIsolation(): void {
  domains.clear();
  traces.length = 0;
}
