import { describe, expect, it } from 'vitest';
import { modelOperationsSnapshot } from './model-operations.js';
import type { HealthSnapshot } from './health-coordinator.js';

describe('model operations projection', () => {
  it('preserves availability and circuit states without probe details', () => {
    const health: HealthSnapshot = {
      generatedAt: 10,
      profiles: [
        { profileId: 'b', modelId: 'm', availability: 'unknown', nextProbeAt: 20, circuit: 'closed', consecutiveFailures: 0 },
        { profileId: 'a', modelId: 'm', availability: 'stale', ageMs: 12, nextProbeAt: 20, circuit: 'open', consecutiveFailures: 3, retryAt: 30 },
      ],
      models: {},
    };
    const result = modelOperationsSnapshot(health);
    expect(result.models.map((model) => model.profileId)).toEqual(['a', 'b']);
    expect(result.models[0]).toMatchObject({ stale: true, unknown: false, circuit: 'open', retryAt: 30 });
    expect(JSON.stringify(result)).not.toContain('detail');
  });
});
