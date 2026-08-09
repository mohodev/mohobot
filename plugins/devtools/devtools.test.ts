/**
 * devtools unit tests.
 *
 * Everything here runs against a fake provider and a throwaway registry set -
 * no network, no real credentials, no runtime. The clock is injected so
 * latency assertions are exact rather than flaky.
 */

import { describe, expect, it } from 'vitest';

import type { AIProvider, AIResponse, ChatOptions } from '../../src/ai/types.js';
import { AIError } from '../../src/ai/types.js';
import type { ChatMessage } from '../../src/core/types.js';
import { createRegistries, type ProviderFactory, type Registries } from '../../src/core/registries.js';
import {
  AIConfigSchema,
  BotConfigSchema,
  MemoryConfigSchema,
  SessionConfigSchema,
  type AIConfig,
  type ResolvedBotConfig,
} from '../../src/config/schema.js';
import {
  MAX_BENCH_RUNS,
  benchmark,
  cmdAi,
  cmdBench,
  cmdDiag,
  cmdModels,
  isMockMode,
  redactHeaders,
  requestPreview,
  type DevtoolsDeps,
} from './commands.js';

/** A credential short enough that the logger's generic pattern scrub misses it. */
const SHORT_KEY = 'abc123xyz';
const LONG_KEY = 'live-key-0123456789abcdefghij';

class FakeProvider implements AIProvider {
  readonly name = 'fake';
  readonly model = 'fake-model';
  readonly calls: ChatMessage[][] = [];
  #n = 0;

  constructor(
    private readonly opts: { reply?: string; failEvery?: number; failAll?: boolean; healthy?: boolean } = {},
  ) {}

  async chat(messages: ChatMessage[], _options: ChatOptions = {}): Promise<AIResponse> {
    this.calls.push(messages);
    this.#n += 1;
    if (this.opts.failAll === true || (this.opts.failEvery !== undefined && this.#n % this.opts.failEvery === 0)) {
      throw new AIError('upstream exploded', { kind: 'server', status: 503, attempts: 2, retryable: true });
    }
    const content = this.opts.reply ?? `fake reply #${this.#n}`;
    return {
      content,
      model: this.model,
      usage: { promptTokens: 7, completionTokens: 11, totalTokens: 18 },
      finishReason: 'stop',
      ms: 5,
    };
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: this.opts.healthy !== false, detail: 'fake' };
  }
}

function makeBotConfig(ai: Partial<AIConfig> = {}): ResolvedBotConfig {
  const base = BotConfigSchema.parse({ id: 'test-bot', name: 'TestBot', adapter: 'console' });
  return {
    ...base,
    ai: AIConfigSchema.parse({ provider: 'fake', model: 'fake-model', apiKey: LONG_KEY, ...ai }),
    session: SessionConfigSchema.parse({}),
    memory: MemoryConfigSchema.parse({}),
  };
}

function makeRegistries(): Registries {
  const reg = createRegistries();
  const factory: ProviderFactory = () => new FakeProvider();
  reg.providers.register('fake', factory, { source: 'test', description: 'fake provider' });
  reg.providers.register('mock', factory, { source: 'builtin', description: 'offline canned responses' });
  reg.gateways.register('console', (() => undefined) as never, { source: 'builtin' });
  reg.storages.register('sqlite', (() => undefined) as never, { source: 'builtin' });
  reg.memories.register('null', (() => undefined) as never, { source: 'builtin' });
  return reg;
}

/** Deterministic clock: every read advances by 10ms. */
function tickingClock(step = 10): () => number {
  let t = 1_000;
  return () => {
    t += step;
    return t;
  };
}

function makeDeps(
  provider: AIProvider | (() => AIProvider),
  overrides: Partial<DevtoolsDeps> = {},
): DevtoolsDeps {
  return {
    getProvider: typeof provider === 'function' ? provider : () => provider,
    registries: makeRegistries(),
    botConfig: makeBotConfig(),
    now: tickingClock(),
    ...overrides,
  };
}

describe('secret redaction', () => {
  it('masks a bearer token as "Bearer [REDACTED]" even when it is too short for pattern scrubbing', () => {
    const headers = redactHeaders({ Authorization: `Bearer ${SHORT_KEY}`, 'Content-Type': 'application/json' });
    expect(headers['Authorization']).toBe('Bearer [REDACTED]');
    expect(JSON.stringify(headers)).not.toContain(SHORT_KEY);
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('masks other credential headers entirely and keeps the auth scheme when present', () => {
    const headers = redactHeaders({
      'x-api-key': SHORT_KEY,
      Cookie: `session=${SHORT_KEY}`,
      Authorization: `Basic ${SHORT_KEY}`,
    });
    expect(headers['x-api-key']).toBe('[REDACTED]');
    expect(headers['Cookie']).toBe('[REDACTED]');
    expect(headers['Authorization']).toBe('Basic [REDACTED]');
  });

  it('falls back to "Bearer [REDACTED]" for a scheme-less authorization value', () => {
    expect(redactHeaders({ Authorization: SHORT_KEY })['Authorization']).toBe('Bearer [REDACTED]');
  });

  it('never renders the configured api key in the request preview', () => {
    const preview = requestPreview(makeBotConfig({ apiKey: SHORT_KEY }).ai);
    expect(preview['Authorization']).toBe('Bearer [REDACTED]');
    expect(JSON.stringify(preview)).not.toContain(SHORT_KEY);
  });

  it('keeps the api key out of !diag output', () => {
    const deps = makeDeps(new FakeProvider(), { botConfig: makeBotConfig({ apiKey: SHORT_KEY }) });
    const card = cmdDiag(deps);
    expect(card.description).not.toContain(SHORT_KEY);
    expect(card.description).toContain('Bearer [REDACTED]');
    expect(card.description).toContain('apiKey=set');
  });
});

describe('!ai', () => {
  it('sends exactly one message with no session history and reports timing + usage', async () => {
    const provider = new FakeProvider({ reply: 'hi there' });
    const card = await cmdAi(makeDeps(provider), ['hello', 'world']);

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toEqual([{ role: 'user', content: 'hello world' }]);
    expect(card.description).toContain('provider=fake');
    expect(card.description).toContain('model=fake-model');
    expect(card.description).toContain('10ms');
    expect(card.description).toContain('tokens prompt=7 completion=11 total=18');
    expect(card.description).toContain('hi there');
  });

  it('returns usage text and calls nothing when the prompt is empty', async () => {
    const provider = new FakeProvider();
    const card = await cmdAi(makeDeps(provider), []);
    expect(card.description).toBe('usage: !ai <prompt>  (single request, no session history)');
    expect(provider.calls).toHaveLength(0);
  });

  it('turns a provider failure into readable text instead of throwing', async () => {
    const card = await cmdAi(makeDeps(new FakeProvider({ failAll: true })), ['boom']);
    expect(card.description).toContain('[ai] failed');
    expect(card.description).toContain('server');
    expect(card.description).toContain('http=503');
  });

  it('survives a provider that cannot even be constructed', async () => {
    const card = await cmdAi(
      makeDeps(() => {
        throw new Error('no credentials');
      }),
      ['hello'],
    );
    expect(card.description).toContain('[ai] provider unavailable');
    expect(card.description).toContain('no credentials');
  });

  it('truncates an oversized reply', async () => {
    const provider = new FakeProvider({ reply: 'x'.repeat(300) });
    const card = await cmdAi(makeDeps(provider, { replyLimit: 50 }), ['long']);
    expect(card.description).toContain('[truncated 250 chars]');
  });
});

describe('!models', () => {
  it('lists registry entries with their source and marks the active one', () => {
    const card = cmdModels(makeDeps(new FakeProvider()));
    expect(card.description).toContain('[models] 2 registered');
    expect(card.description).toContain('fake (source: test)');
    expect(card.description).toContain('mock (source: builtin)');
    expect(card.description).toContain('<- active');
  });

  it('flags mock mode when no api key is configured', () => {
    const deps = makeDeps(new FakeProvider(), { botConfig: makeBotConfig({ apiKey: '' }) });
    expect(isMockMode(deps.botConfig.ai)).toBe(true);
    expect(cmdModels(deps).description).toContain('MOCK mode');
  });
});

describe('!diag', () => {
  it('reports all four registries and the bot wiring', () => {
    const card = cmdDiag(makeDeps(new FakeProvider()));
    expect(card.description).toContain('providers: fake[test], mock[builtin]');
    expect(card.description).toContain('gateways : console[builtin]');
    expect(card.description).toContain('storages : sqlite[builtin]');
    expect(card.description).toContain('memories : null[builtin]');
    expect(card.description).toContain('id=test-bot');
    expect(card.description).toContain('adapter=console');
    expect(card.description).toContain('ai.provider=fake');
    expect(card.description).toContain('ai.model=fake-model');
  });
});

describe('!bench', () => {
  it('runs n requests and reports the latency spread', async () => {
    const provider = new FakeProvider();
    const card = await cmdBench(makeDeps(provider), ['3', 'hello', 'bench']);

    expect(provider.calls).toHaveLength(3);
    expect(provider.calls[0]).toEqual([{ role: 'user', content: 'hello bench' }]);
    expect(card.description).toContain('runs=3');
    expect(card.description).toContain('ok=3');
    expect(card.description).toContain('failed=0');
    expect(card.description).toContain('success=100%');
    expect(card.description).toContain('min=10ms max=10ms avg=10.0ms');
  });

  it(`caps n at ${MAX_BENCH_RUNS}`, async () => {
    const provider = new FakeProvider();
    const card = await cmdBench(makeDeps(provider), ['99', 'flood']);
    expect(provider.calls).toHaveLength(MAX_BENCH_RUNS);
    expect(card.description).toContain(`capped at ${MAX_BENCH_RUNS}`);
  });

  it('reports a partial success rate without throwing', async () => {
    const provider = new FakeProvider({ failEvery: 2 });
    const card = await cmdBench(makeDeps(provider), ['4', 'flaky']);
    expect(card.description).toContain('ok=2');
    expect(card.description).toContain('failed=2');
    expect(card.description).toContain('success=50%');
    expect(card.description).toContain('first error:');
  });

  it('rejects bad arguments with usage text', async () => {
    const provider = new FakeProvider();
    expect((await cmdBench(makeDeps(provider), [])).description).toContain('usage: !bench');
    expect((await cmdBench(makeDeps(provider), ['abc', 'x'])).description).toContain('usage: !bench');
    expect((await cmdBench(makeDeps(provider), ['2'])).description).toContain('usage: !bench');
    expect(provider.calls).toHaveLength(0);
  });

  it('exposes the raw benchmark result for programmatic use', async () => {
    const result = await benchmark(makeDeps(new FakeProvider()), 2, 'ping');
    expect(result).toMatchObject({ runs: 2, ok: 2, failed: 0, minMs: 10, maxMs: 10, avgMs: 10 });
  });
});
