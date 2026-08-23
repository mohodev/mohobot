import { describe, expect, it } from 'vitest';
import { BudgetedProvider, ModelBudgetError } from './router.js';
import type { AIProvider } from './types.js';

const provider: AIProvider = {
  name: 'fake', model: 'fake',
  async chat() { return { content: 'ok', model: 'fake', ms: 0 }; },
  async health() { return { ok: true }; },
};

describe('BudgetedProvider', () => {
  it('reserves RPM for interactive replies over background cognition', async () => {
    const guarded = new BudgetedProvider(provider, { rpm: 3, reserveRpm: 1, maxConcurrent: 3 });
    await guarded.chat([], { task: 'reflection' });
    await guarded.chat([], { task: 'world' });
    await expect(guarded.chat([], { task: 'profile' })).rejects.toBeInstanceOf(ModelBudgetError);
    await expect(guarded.chat([], { task: 'reply' })).resolves.toMatchObject({ content: 'ok' });
  });

  it('passes chat options through untouched (no token ceilings anymore)', async () => {
    let seenTemperature: number | undefined;
    const inner: AIProvider = { ...provider, async chat(_m, options) { seenTemperature = options?.temperature; return { content: 'ok', model: 'fake', ms: 0 }; } };
    const guarded = new BudgetedProvider(inner, {});
    await guarded.chat([], { task: 'reply', temperature: 0.5 });
    expect(seenTemperature).toBe(0.5);
  });
});
