import { describe, expect, it } from 'vitest';
import { LaneProvider } from './lane-provider.js';
import type { AIProvider } from './types.js';

function provider(model = 'default'): AIProvider & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    name: 'test', model, calls,
    async chat(_messages, options) {
      calls.push({ ...(options ?? {}) });
      return { content: 'ok', model: options?.model ?? model, ms: 1 };
    },
    async health() { return { ok: true }; },
  };
}

describe('LaneProvider', () => {
  it('keeps lane routing disabled by default', async () => {
    const inner = provider();
    const lane = new LaneProvider(inner, undefined, () => []);
    await lane.chat([{ role: 'user', content: 'hi' }], { task: 'planner' });
    expect(inner.calls[0]).toMatchObject({ task: 'planner' });
    expect(inner.calls[0]).not.toHaveProperty('model');
  });

  it('selects configured healthy models for planner and tool calls', async () => {
    const inner = provider();
    const snapshots = () => [{
      id: 'bot', name: 'Bot', running: true, adapter: 'test', model: 'default', provider: 'test',
      gateway: {} as never, sessions: 0, plugins: [], pipeline: { handled: 0, replied: 0, skipped: 0, aiFailures: 0, rateLimited: 0 },
      modelHealth: { generatedAt: 1, profiles: [], models: { 'planner-model': { availability: 'available' as const }, 'tool-model': { availability: 'available' as const } } },
    }];
    const lane = new LaneProvider(inner, {
      enabled: true,
      policies: {
        planner: { lane: 'planner', preferredModels: ['planner-model'], fallbackModels: [] },
        'tool-call': { lane: 'tool-call', preferredModels: ['tool-model'], fallbackModels: [] },
      },
    }, snapshots);
    await lane.chat([{ role: 'user', content: 'plan' }], { task: 'planner' });
    await lane.chat([{ role: 'user', content: 'tool' }], { tools: [{ type: 'function', function: { name: 'x', description: '', parameters: {} } }] });
    expect(inner.calls).toEqual([
      expect.objectContaining({ task: 'planner', model: 'planner-model' }),
      expect.objectContaining({ task: 'tool-call', model: 'tool-model' }),
    ]);
  });
});
