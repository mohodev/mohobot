import type { HealthSnapshot, AvailabilityState } from './health-coordinator.js';

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
