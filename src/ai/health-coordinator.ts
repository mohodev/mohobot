import type { Logger } from '../core/logger.js';
import type { TaskManager } from '../core/task-manager.js';
import type { CircuitSnapshot, CircuitState } from './circuit-breaker.js';

export interface ProfileProbeResult {
  id: string;
  model: string;
  ok: boolean;
  checkedAt?: number;
  latencyMs?: number;
  detail?: string;
  circuit?: CircuitSnapshot;
}

export interface ProbeRouter {
  profileIds(): string[];
  probeProfile(id: string, signal?: AbortSignal): Promise<ProfileProbeResult>;
}

export interface ProbeProfile {
  id: string;
  model: string;
  probe(signal?: AbortSignal): Promise<{ ok: boolean; latencyMs?: number; circuit?: CircuitSnapshot }>;
  circuit?: () => CircuitSnapshot;
}

export type AvailabilityState = 'available' | 'unavailable' | 'open' | 'stale' | 'unknown';

export interface ProfileHealthSnapshot {
  profileId: string;
  modelId: string;
  availability: AvailabilityState;
  checkedAt?: number;
  ageMs?: number;
  latencyMs?: number;
  nextProbeAt: number;
  circuit: CircuitState;
  consecutiveFailures: number;
  retryAt?: number;
}

export interface HealthSnapshot {
  generatedAt: number;
  profiles: ProfileHealthSnapshot[];
  models: Record<string, { availability: AvailabilityState; checkedAt?: number; latencyMs?: number }>;
}

export interface HealthCoordinatorOptions {
  router?: ProbeRouter;
  profiles?: ProbeProfile[];
  logger: Logger;
  concurrency?: number;
  timeoutMs?: number;
  intervalMs?: number;
  ttlMs?: number;
  staleMs?: number;
  jitterRatio?: number;
  now?: () => number;
  random?: () => number;
}

interface ProbeTarget {
  id: string;
  model: string;
  probe(signal?: AbortSignal): Promise<ProfileProbeResult>;
  circuit?: () => CircuitSnapshot;
}

interface HealthRecord {
  ok: boolean;
  checkedAt: number;
  latencyMs?: number;
  circuit?: CircuitSnapshot;
}

const CLOSED: CircuitSnapshot = { state: 'closed', consecutiveFailures: 0 };

function positive(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result <= 0) throw new Error(`${name} must be positive`);
  return result;
}

/** Coordinates bounded model probes without owning timers or exposing provider secrets. */
export class HealthCoordinator {
  readonly #targets = new Map<string, ProbeTarget>();
  readonly #records = new Map<string, HealthRecord>();
  readonly #due = new Map<string, number>();
  readonly #inflight = new Map<string, Promise<void>>();
  readonly #logger: Logger;
  readonly #concurrency: number;
  readonly #timeoutMs: number;
  readonly #intervalMs: number;
  readonly #ttlMs: number;
  readonly #staleMs: number;
  readonly #jitterRatio: number;
  readonly #now: () => number;
  readonly #random: () => number;

  constructor(options: HealthCoordinatorOptions) {
    this.#logger = options.logger.child({ component: 'model-health' });
    this.#concurrency = Math.max(1, Math.floor(positive(options.concurrency, 4, 'concurrency')));
    this.#timeoutMs = positive(options.timeoutMs, 10_000, 'timeoutMs');
    this.#intervalMs = positive(options.intervalMs, 60_000, 'intervalMs');
    this.#ttlMs = positive(options.ttlMs, 90_000, 'ttlMs');
    this.#staleMs = positive(options.staleMs, 300_000, 'staleMs');
    if (this.#staleMs < this.#ttlMs) throw new Error('staleMs must be greater than or equal to ttlMs');
    this.#jitterRatio = options.jitterRatio ?? 0.2;
    if (!Number.isFinite(this.#jitterRatio) || this.#jitterRatio < 0 || this.#jitterRatio > 1) throw new Error('jitterRatio must be between 0 and 1');
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;

    for (const profile of options.profiles ?? []) this.#addTarget({
      id: profile.id,
      model: profile.model,
      probe: async (signal) => ({ id: profile.id, model: profile.model, ...await profile.probe(signal) }),
      circuit: profile.circuit,
    });
    if (options.router) for (const id of options.router.profileIds()) this.#addTarget({
      id,
      model: id,
      probe: (signal) => options.router!.probeProfile(id, signal),
    });
    if (this.#targets.size === 0) throw new Error('at least one probe target is required');
    for (const id of this.#targets.keys()) this.#due.set(id, this.#now());
  }

  /** Register periodic work with TaskManager. The coordinator itself owns no timer. */
  start(tasks: TaskManager): string {
    const cadence = Math.max(100, Math.min(this.#intervalMs, this.#ttlMs) / 2);
    return tasks.spawn(() => this.tick(), { name: 'model-health', intervalMs: cadence, immediate: true, continueOnError: true });
  }

  /** Probe due profiles. Concurrent callers share each profile's in-flight probe. */
  async tick(options: { force?: boolean } = {}): Promise<HealthSnapshot> {
    const now = this.#now();
    const ids = [...this.#targets.keys()].filter((id) => options.force || (this.#due.get(id) ?? 0) <= now);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(this.#concurrency, ids.length) }, async () => {
      while (cursor < ids.length) {
        const id = ids[cursor++];
        if (id) await this.#probe(id);
      }
    });
    await Promise.all(workers);
    return this.snapshot();
  }

  snapshot(): HealthSnapshot {
    const now = this.#now();
    const profiles = [...this.#targets.values()].map((target): ProfileHealthSnapshot => {
      const record = this.#records.get(target.id);
      const circuit = record?.circuit ?? target.circuit?.() ?? CLOSED;
      const ageMs = record ? Math.max(0, now - record.checkedAt) : undefined;
      let availability: AvailabilityState;
      if (circuit.state === 'open') availability = 'open';
      else if (!record || ageMs === undefined || ageMs > this.#staleMs) availability = 'unknown';
      else if (ageMs > this.#ttlMs) availability = 'stale';
      else availability = record.ok ? 'available' : 'unavailable';
      return {
        profileId: target.id,
        modelId: target.model,
        availability,
        ...(record ? { checkedAt: record.checkedAt, ageMs, ...(record.latencyMs !== undefined ? { latencyMs: record.latencyMs } : {}) } : {}),
        nextProbeAt: this.#due.get(target.id) ?? now,
        circuit: circuit.state,
        consecutiveFailures: circuit.consecutiveFailures,
        ...(circuit.retryAt !== undefined ? { retryAt: circuit.retryAt } : {}),
      };
    }).sort((a, b) => a.profileId.localeCompare(b.profileId));
    const models: HealthSnapshot['models'] = {};
    const rank: Record<AvailabilityState, number> = { available: 4, stale: 3, unknown: 2, unavailable: 1, open: 0 };
    for (const profile of profiles) {
      const current = models[profile.modelId];
      if (!current || rank[profile.availability] > rank[current.availability]) models[profile.modelId] = {
        availability: profile.availability,
        ...(profile.checkedAt !== undefined ? { checkedAt: profile.checkedAt } : {}),
        ...(profile.latencyMs !== undefined ? { latencyMs: profile.latencyMs } : {}),
      };
    }
    return { generatedAt: now, profiles, models };
  }

  #addTarget(target: ProbeTarget): void {
    if (!target.id.trim() || !target.model.trim()) throw new Error('profile id and model must not be empty');
    if (this.#targets.has(target.id)) throw new Error(`duplicate probe profile: ${target.id}`);
    this.#targets.set(target.id, target);
  }

  #jitterDelay(): number {
    const factor = 1 + ((this.#random() * 2) - 1) * this.#jitterRatio;
    return Math.max(1, Math.round(this.#intervalMs * factor));
  }

  #probe(id: string): Promise<void> {
    const active = this.#inflight.get(id);
    if (active) return active;
    const target = this.#targets.get(id)!;
    const started = this.#now();
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('probe timeout')); }, this.#timeoutMs);
      timer.unref?.();
    });
    const work = Promise.race([target.probe(controller.signal), timeout]).then((result) => {
      const checkedAt = result.checkedAt ?? this.#now();
      this.#records.set(id, {
        ok: result.ok,
        checkedAt,
        latencyMs: result.latencyMs ?? Math.max(0, this.#now() - started),
        circuit: result.circuit ?? target.circuit?.(),
      });
      if (result.model && result.model !== target.model) target.model = result.model;
    }).catch((error: unknown) => {
      this.#records.set(id, { ok: false, checkedAt: this.#now(), latencyMs: Math.max(0, this.#now() - started), circuit: target.circuit?.() });
      this.#logger.debug({ profileId: id, err: error instanceof Error ? error.name : 'probe_failed' }, 'model health probe failed');
    }).finally(() => {
      if (timer) clearTimeout(timer);
      this.#due.set(id, this.#now() + this.#jitterDelay());
      this.#inflight.delete(id);
    });
    this.#inflight.set(id, work);
    return work;
  }
}
