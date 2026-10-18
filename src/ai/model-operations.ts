import type { HealthSnapshot, AvailabilityState } from './health-coordinator.js';
import type { BotSnapshot } from '../bot/runtime.js';
import type { UsageRecorder, UsageTotals } from './usage.js';

/** Stable, provider-neutral view consumed by operator and admin surfaces. */
export interface ModelOperation {
  profileId: string;
  modelId: string;
  availability: AvailabilityState;
  circuit: 'closed' | 'open' | 'half-open';
  stale: boolean;
  unknown: boolean;
  checkedAt?: number;
  ageMs?: number;
  latencyMs?: number;
  nextProbeAt: number;
  consecutiveFailures: number;
  retryAt?: number;
}

export interface ModelOperationsSnapshot {
  generatedAt: number;
  models: ModelOperation[];
}

/**
 * Normalize health into the model-operations contract. This is deliberately a
 * projection, so callers cannot accidentally expose provider probe details.
 */
export function modelOperationsSnapshot(health: HealthSnapshot): ModelOperationsSnapshot {
  return {
    generatedAt: health.generatedAt,
    models: health.profiles.map((profile) => ({
      profileId: profile.profileId,
      modelId: profile.modelId,
      availability: profile.availability,
      circuit: profile.circuit,
      stale: profile.availability === 'stale',
      unknown: profile.availability === 'unknown',
      ...(profile.checkedAt !== undefined ? { checkedAt: profile.checkedAt } : {}),
      ...(profile.ageMs !== undefined ? { ageMs: profile.ageMs } : {}),
      ...(profile.latencyMs !== undefined ? { latencyMs: profile.latencyMs } : {}),
      nextProbeAt: profile.nextProbeAt,
      consecutiveFailures: profile.consecutiveFailures,
      ...(profile.retryAt !== undefined ? { retryAt: profile.retryAt } : {}),
    })).sort((a, b) => a.profileId.localeCompare(b.profileId)),
  };
}

export function isUsableModel(availability: AvailabilityState): boolean {
  return availability === 'available';
}

// ---------------------------------------------------------------------------
// Cross-bot model operations dashboard
// ---------------------------------------------------------------------------

/** Sanitized per-bot model summary (no API keys, endpoints, or secrets). */
export interface BotModelSummary {
  botId: string;
  botName: string;
  running: boolean;
  provider: string;
  model: string;
  sessions: number;
  health: ModelOperationsSnapshot | null;
  usage?: { calls: number; input: number; output: number };
}

export interface DashboardOverview {
  generatedAt: number;
  bots: BotModelSummary[];
  providers: ProviderSummary[];
  totals: { bots: number; running: number; models: number; availableModels: number };
  events: ModelOperationEvent[];
}

export interface ModelOperationEvent {
  at: number;
  kind: 'lane' | 'fallback' | 'circuit';
  lane?: TaskLaneType;
  model?: string;
  detail: string;
}

const recentEvents: ModelOperationEvent[] = [];
export function recordModelOperationEvent(event: Omit<ModelOperationEvent, 'at'>): void {
  recentEvents.push({ ...event, at: Date.now() });
  if (recentEvents.length > 100) recentEvents.splice(0, recentEvents.length - 100);
}
export function recentModelOperationEvents(): ModelOperationEvent[] { return recentEvents.slice(-50).reverse(); }

export interface ProviderSummary {
  provider: string;
  modelCount: number;
  availableCount: number;
  avgLatencyMs: number | null;
  models: Array<{
    modelId: string;
    availability: AvailabilityState;
    latencyMs?: number;
    consecutiveFailures: number;
  }>;
}

export interface BotUsageDetail {
  botId: string;
  botName: string;
  running: boolean;
  provider: string;
  model: string;
  health: ModelOperationsSnapshot | null;
  usage: Array<{ module: string; name: string; calls: number; input: number; output: number }>;
}

export interface ProviderHealthDetail {
  provider: string;
  bots: Array<{ botId: string; botName: string; model: string }>;
  models: Array<{
    modelId: string;
    availability: AvailabilityState;
    latencyMs?: number;
    circuit: 'closed' | 'open' | 'half-open';
    consecutiveFailures: number;
    checkedAt?: number;
  }>;
  avgLatencyMs: number | null;
  availableCount: number;
  totalCount: number;
}

export interface ModelOperationsDashboardDeps {
  snapshots: () => BotSnapshot[];
  usage?: Pick<UsageRecorder, 'totals'>;
}

/**
 * Aggregates model operations across all configured bots. Every output field
 * is sanitized: no API keys, endpoint URLs, or other credentials leak through.
 */
export class ModelOperationsDashboard {
  readonly #deps: ModelOperationsDashboardDeps;

  constructor(deps: ModelOperationsDashboardDeps) {
    this.#deps = deps;
  }

  overview(): DashboardOverview {
    const now = Date.now();
    const snaps = this.#deps.snapshots();
    const bots = snaps.map((snap) => this.#botSummary(snap));
    const providers = this.#aggregateProviders(snaps);
    const allModels = new Set<string>();
    const availableModels = new Set<string>();
    for (const bot of bots) {
      if (bot.health) {
        for (const m of bot.health.models) {
          allModels.add(m.modelId);
          if (m.availability === 'available') availableModels.add(m.modelId);
        }
      }
    }
    return {
      generatedAt: now,
      bots,
      providers,
      totals: {
        bots: snaps.length,
        running: snaps.filter((s) => s.running).length,
        models: allModels.size,
        availableModels: availableModels.size,
      },
      events: recentModelOperationEvents(),
    };
  }

  async botUsage(botId: string): Promise<BotUsageDetail | null> {
    const snap = this.#deps.snapshots().find((s) => s.id === botId);
    if (!snap) return null;
    const health = snap.modelHealth ? modelOperationsSnapshot(snap.modelHealth) : null;
    const usage = this.#deps.usage ? await this.#deps.usage.totals(botId, 1) : [];
    return {
      botId: snap.id,
      botName: snap.name,
      running: snap.running,
      provider: snap.provider,
      model: snap.model,
      health,
      usage: usage.map((row) => ({ ...row })),
    };
  }

  providerHealth(providerName: string): ProviderHealthDetail | null {
    const snaps = this.#deps.snapshots();
    const matchingBots = snaps.filter((s) => s.provider === providerName);
    if (matchingBots.length === 0) return null;
    const models: ProviderHealthDetail['models'] = [];
    const seen = new Set<string>();
    for (const snap of matchingBots) {
      if (!snap.modelHealth) continue;
      const ops = modelOperationsSnapshot(snap.modelHealth);
      for (const m of ops.models) {
        if (seen.has(m.modelId)) continue;
        seen.add(m.modelId);
        models.push({
          modelId: m.modelId,
          availability: m.availability,
          ...(m.latencyMs !== undefined ? { latencyMs: m.latencyMs } : {}),
          circuit: m.circuit,
          consecutiveFailures: m.consecutiveFailures,
          ...(m.checkedAt !== undefined ? { checkedAt: m.checkedAt } : {}),
        });
      }
    }
    const latencies = models.filter((m) => m.latencyMs !== undefined).map((m) => m.latencyMs!);
    const avgLatencyMs = latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;
    return {
      provider: providerName,
      bots: matchingBots.map((s) => ({ botId: s.id, botName: s.name, model: s.model })),
      models,
      avgLatencyMs,
      availableCount: models.filter((m) => m.availability === 'available').length,
      totalCount: models.length,
    };
  }

  #botSummary(snap: BotSnapshot): BotModelSummary {
    const health = snap.modelHealth ? modelOperationsSnapshot(snap.modelHealth) : null;
    let usage: BotModelSummary['usage'];
    if (health) {
      const totalFailures = health.models.reduce((sum, m) => sum + m.consecutiveFailures, 0);
      usage = { calls: health.models.length, input: 0, output: totalFailures };
    }
    return {
      botId: snap.id,
      botName: snap.name,
      running: snap.running,
      provider: snap.provider,
      model: snap.model,
      sessions: snap.sessions,
      health,
      ...(usage ? { usage } : {}),
    };
  }

  #aggregateProviders(snaps: BotSnapshot[]): ProviderSummary[] {
    const groups = new Map<string, BotSnapshot[]>();
    for (const snap of snaps) {
      const list = groups.get(snap.provider) ?? [];
      list.push(snap);
      groups.set(snap.provider, list);
    }
    const result: ProviderSummary[] = [];
    for (const [provider, group] of groups) {
      const models: ProviderSummary['models'] = [];
      const seen = new Set<string>();
      for (const snap of group) {
        if (!snap.modelHealth) continue;
        const ops = modelOperationsSnapshot(snap.modelHealth);
        for (const m of ops.models) {
          if (seen.has(m.modelId)) continue;
          seen.add(m.modelId);
          models.push({
            modelId: m.modelId,
            availability: m.availability,
            ...(m.latencyMs !== undefined ? { latencyMs: m.latencyMs } : {}),
            consecutiveFailures: m.consecutiveFailures,
          });
        }
      }
      const latencies = models.filter((m) => m.latencyMs !== undefined).map((m) => m.latencyMs!);
      const avgLatencyMs = latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;
      result.push({
        provider,
        modelCount: models.length,
        availableCount: models.filter((m) => m.availability === 'available').length,
        avgLatencyMs,
        models,
      });
    }
    return result.sort((a, b) => a.provider.localeCompare(b.provider));
  }
}

// ---------------------------------------------------------------------------
// Task lane model assignment
// ---------------------------------------------------------------------------

export type TaskLaneType = 'chat' | 'planner' | 'operator' | 'tool-call';

export interface TaskLanePolicy {
  lane: TaskLaneType;
  preferredModels: string[];
  fallbackModels: string[];
}

export interface TaskLaneAssignment {
  lane: TaskLaneType;
  modelId: string;
  source: 'preferred' | 'fallback' | 'default';
}

const DEFAULT_LANE_POLICIES: Record<TaskLaneType, TaskLanePolicy> = {
  chat: { lane: 'chat', preferredModels: [], fallbackModels: [] },
  planner: { lane: 'planner', preferredModels: [], fallbackModels: [] },
  operator: { lane: 'operator', preferredModels: [], fallbackModels: [] },
  'tool-call': { lane: 'tool-call', preferredModels: [], fallbackModels: [] },
};

export interface TaskLaneDeps {
  snapshots: () => BotSnapshot[];
  policies?: Partial<Record<TaskLaneType, TaskLanePolicy>>;
}

/**
 * Assigns models to task lanes by checking preferred/fallback lists against
 * live health data. Falls back to the first available model when no lane
 * preference matches.
 */
export class TaskLane {
  readonly #deps: TaskLaneDeps;
  readonly #policies: Record<TaskLaneType, TaskLanePolicy>;

  constructor(deps: TaskLaneDeps) {
    this.#deps = deps;
    this.#policies = { ...DEFAULT_LANE_POLICIES, ...deps.policies };
  }

  assignModel(task: TaskLaneType, preferredModel?: string): TaskLaneAssignment | null {
    const allModels = this.#collectAvailableModels();
    if (preferredModel && allModels.has(preferredModel)) {
      return { lane: task, modelId: preferredModel, source: 'preferred' };
    }
    const policy = this.#policies[task];
    for (const modelId of policy.preferredModels) {
      if (allModels.has(modelId)) return { lane: task, modelId, source: 'preferred' };
    }
    for (const modelId of policy.fallbackModels) {
      if (allModels.has(modelId)) return { lane: task, modelId, source: 'fallback' };
    }
    const first = allModels.keys().next();
    if (!first.done) return { lane: task, modelId: first.value, source: 'default' };
    return null;
  }

  lanes(): Record<TaskLaneType, TaskLanePolicy> {
    return { ...this.#policies };
  }

  #collectAvailableModels(): Map<string, AvailabilityState> {
    const result = new Map<string, AvailabilityState>();
    for (const snap of this.#deps.snapshots()) {
      if (!snap.modelHealth) continue;
      for (const [modelId, info] of Object.entries(snap.modelHealth.models)) {
        const current = result.get(modelId);
        if (!current || rank(info.availability) > rank(current)) {
          result.set(modelId, info.availability);
        }
      }
    }
    return new Map([...result].filter(([, a]) => a === 'available'));
  }
}

const AVAILABILITY_RANK: Record<AvailabilityState, number> = { available: 4, stale: 3, unknown: 2, unavailable: 1, open: 0 };
function rank(a: AvailabilityState): number { return AVAILABILITY_RANK[a]; }
