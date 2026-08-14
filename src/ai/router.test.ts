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

  it('does not pass an output ceiling when the task budget is zero', async () => {
    let seen: number | undefined = 1;
    const inner: AIProvider = { ...provider, async chat(_m, options) { seen = options?.maxTokens; return { content: 'ok', model: 'fake', ms: 0 }; } };
    const guarded = new BudgetedProvider(inner, { maxTokens: { reply: 0 } });
    await guarded.chat([], { task: 'reply', maxTokens: 2048 });
    expect(seen).toBeUndefined();
  });

  it('caps a task token request at its configured ceiling', async () => {
    let seen = 0;
    const inner: AIProvider = { ...provider, async chat(_m, options) { seen = options?.maxTokens ?? 0; return { content: 'ok', model: 'fake', ms: 0 }; } };
    const guarded = new BudgetedProvider(inner, { maxTokens: { reply: 42 } });
    await guarded.chat([], { task: 'reply', maxTokens: 100 });
    expect(seen).toBe(42);
  });
});
