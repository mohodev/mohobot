/**
 * Unit tests for the model catalog.
 *
 * No network: every test runs against the frozen fixture below or an injected
 * fake fetch. The fixture is a trimmed copy of a real GET /models response and
 * deliberately carries all four metadata defects the linter must catch.
 */

import { describe, expect, it } from 'vitest';

import { createNullLogger } from '../../src/core/logger.js';
import type { CommandContext, PluginCommand, PluginContext } from '../../src/plugins/types.js';
import type { ScopedStorage, StoredRecord } from '../../src/storage/types.js';
import plugin from './index.js';
import {
  filterFree,
  findModel,
  formatFreeList,
  formatLintReport,
  formatModelInfo,
  hasSingleAsteriskEmphasis,
  isTruncatedText,
  lintCatalog,
  parseModels,
  sanitizeDescription,
  summarizeLint,
} from './catalog.js';
import {
  CACHE_KEY,
  CatalogClient,
  interpretCompletion,
  type FetchLike,
  type MinimalRequestInit,
  type MinimalResponse,
} from './client.js';

/* ------------------------------------------------------------------ */
/* fixture - verbatim shapes from the live gateway                      */
/* ------------------------------------------------------------------ */

/** The real, broken description: single '*' where '**' was meant. */
const LING_DESCRIPTION =
  '*Ling-3.0-flash* is a *124B-parameter Mixture-of-Experts (MoE) model*, with approximately ' +
  '*5.1B parameters activated per token*. The model is designed with *token efficiency and ' +
  'production-scale agentic inference* as key priorities, enabling developers...';

const MODELS_FIXTURE = {
  data: [
    {
      id: 'tencent/hy3:free',
      name: 'Tencent: Hy3 (free)',
      description:
        'Hy3 is a 295B-parameter Mixture-of-Experts model from Tencent, activating 21B parameters per token.',
      context_length: 262144,
      architecture: { input_modalities: ['text'], output_modalities: ['text'], tokenizer: 'Other' },
      pricing: { prompt: '0.000000000000', completion: '0.000000000000', request: '0' },
      top_provider: { context_length: 262144, max_completion_tokens: 128000, is_moderated: false },
      supported_parameters: ['max_tokens', 'temperature', 'tools'],
      isFree: true,
    },
    {
      id: 'nvidia/nemotron-3-ultra-550b-a55b:free',
      name: 'NVIDIA: Nemotron 3 Ultra (free)',
      description: 'Nemotron 3 Ultra is a 550B mixture-of-experts reasoning model that...',
      context_length: 1000000,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      pricing: { prompt: '0', completion: '0' },
      top_provider: { context_length: 1000000, max_completion_tokens: 64000 },
      supported_parameters: ['max_tokens', 'temperature', 'reasoning'],
      isFree: true,
    },
    {
      // defect 1 (single-asterisk markdown) + defect 2 (no vendor prefix)
      // + defect 4 (truncated description), exactly as served upstream.
      id: 'inclusionai/ling-3.0-flash',
      name: 'Ling-3.0-flash',
      description: LING_DESCRIPTION,
      context_length: 131072,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      pricing: { prompt: '0.00000015', completion: '0.0000006' },
      top_provider: { context_length: 131072, max_completion_tokens: 32000 },
      supported_parameters: ['max_tokens', 'temperature'],
    },
    {
      // defect 3 (alias id) + defect 2 (no vendor prefix)
      id: '~deepseek/deepseek-v4-flash-latest',
      name: 'DeepSeek V4 Flash Latest',
      description: 'Always points at the newest DeepSeek V4 Flash build.',
      context_length: 163840,
      pricing: { prompt: '0.00000027', completion: '0.0000011' },
      top_provider: { context_length: 163840, max_completion_tokens: 65536 },
      supported_parameters: ['max_tokens'],
    },
    {
      // defect 2 only; proper '**bold**' must NOT be flagged as defect 1.
      id: 'anthropic/claude-opus-5',
      name: 'Claude Opus 5',
      description: '**Claude Opus 5** is the flagship Anthropic model.',
      context_length: 200000,
      pricing: { prompt: '0.000015', completion: '0.000075' },
      top_provider: { context_length: 200000, max_completion_tokens: 64000 },
      supported_parameters: ['max_tokens', 'temperature', 'tools'],
    },
    {
      // metadata simply missing - must be tolerated, then reported.
      id: 'broken/no-context',
      name: 'Broken: No Context',
      description: '',
      pricing: {},
    },
    // garbage the parser has to shrug off
    null,
    42,
    'not-a-model',
    {},
    { name: 'entry with no id' },
    { id: 'tencent/hy3:free', name: 'duplicate that must be ignored' },
  ],
};

const FIXTURE_MODEL_COUNT = 6;

function fixtureModels() {
  return parseModels(MODELS_FIXTURE);
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

class MemoryScopedStorage implements ScopedStorage {
  readonly entries = new Map<string, unknown>();
  saves = 0;

  async save<T>(key: string, value: T): Promise<void> {
    this.saves += 1;
    this.entries.set(key, JSON.parse(JSON.stringify(value)) as unknown);
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.entries.get(key) as T | undefined;
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async query<T>(): Promise<StoredRecord<T>[]> {
    return [];
  }
}

interface FakeFetch {
  fetch: FetchLike;
  calls: { url: string; init?: MinimalRequestInit }[];
}

function makeFetch(
  handler: (url: string, init?: MinimalRequestInit) => MinimalResponse | Promise<MinimalResponse>,
): FakeFetch {
  const calls: { url: string; init?: MinimalRequestInit }[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return handler(url, init);
    },
  };
}

function jsonResponse(body: unknown, status = 200): MinimalResponse {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

/* ------------------------------------------------------------------ */
/* parseModels                                                         */
/* ------------------------------------------------------------------ */

describe('parseModels', () => {
  it('keeps usable entries and skips garbage and duplicates', () => {
    const models = fixtureModels();
    expect(models).toHaveLength(FIXTURE_MODEL_COUNT);
    expect(models.map((m) => m.id)).toContain('inclusionai/ling-3.0-flash');
    expect(models.filter((m) => m.id === 'tencent/hy3:free')).toHaveLength(1);
  });

  it('never throws on hostile input', () => {
    expect(parseModels(undefined)).toEqual([]);
    expect(parseModels(null)).toEqual([]);
    expect(parseModels(42)).toEqual([]);
    expect(parseModels('{"broken": ')).toEqual([]);
    expect(parseModels({ data: 'not-an-array' })).toEqual([]);
    expect(parseModels([{ id: 'x/y' }])).toHaveLength(1);
  });

  it('accepts a bare array, a {models:[]} wrapper and raw JSON text', () => {
    expect(parseModels([{ id: 'a/b' }])[0]?.id).toBe('a/b');
    expect(parseModels({ models: [{ id: 'a/b' }] })[0]?.id).toBe('a/b');
    expect(parseModels(JSON.stringify(MODELS_FIXTURE))).toHaveLength(FIXTURE_MODEL_COUNT);
  });

  it('fills defaults for missing fields instead of failing', () => {
    const model = fixtureModels().find((m) => m.id === 'broken/no-context');
    expect(model).toBeDefined();
    expect(model?.name).toBe('Broken: No Context');
    expect(model?.contextLength).toBeUndefined();
    expect(model?.maxCompletionTokens).toBeUndefined();
    expect(model?.supportedParameters).toEqual([]);
    expect(model?.cleanDescription).toBe('');
  });

  it('derives vendor, alias and free flags from the id', () => {
    const models = fixtureModels();
    const alias = models.find((m) => m.id === '~deepseek/deepseek-v4-flash-latest');
    expect(alias?.tildePrefixed).toBe(true);
    expect(alias?.vendor).toBe('deepseek');
    expect(alias?.free).toBe(false);

    const free = models.find((m) => m.id === 'tencent/hy3:free');
    expect(free?.free).toBe(true);
    expect(free?.zeroPriced).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* sanitizeDescription                                                 */
/* ------------------------------------------------------------------ */

describe('sanitizeDescription', () => {
  it('promotes the ling-3.0-flash single asterisks to bold', () => {
    const clean = sanitizeDescription(LING_DESCRIPTION);
    expect(clean).toContain('**Ling-3.0-flash**');
    expect(clean).toContain('**124B-parameter Mixture-of-Experts (MoE) model**');
    expect(clean).toContain('**5.1B parameters activated per token**');
    // the cross-sentence pairing ', with approximately ' must stay plain text
    expect(clean).toContain('**, with approximately **5.1B');
    expect(hasSingleAsteriskEmphasis(clean)).toBe(false);
  });

  it('normalises the upstream truncation marker', () => {
    const clean = sanitizeDescription(LING_DESCRIPTION);
    expect(clean.endsWith('\u2026')).toBe(true);
    expect(clean.endsWith('...')).toBe(false);
    expect(isTruncatedText(LING_DESCRIPTION)).toBe(true);
    expect(isTruncatedText('a complete sentence.')).toBe(false);
  });

  it('leaves proper bold alone and drops unpaired asterisks', () => {
    expect(sanitizeDescription('**already bold** text')).toBe('**already bold** text');
    expect(sanitizeDescription('a lone * asterisk')).toBe('a lone  asterisk');
    expect(sanitizeDescription('mixed **bold** and *italic* run')).toBe(
      'mixed **bold** and **italic** run',
    );
  });

  it('is total: any input type yields a string', () => {
    expect(sanitizeDescription(undefined)).toBe('');
    expect(sanitizeDescription(null)).toBe('');
    expect(sanitizeDescription(123)).toBe('');
    expect(sanitizeDescription('   ')).toBe('');
  });

  it('detects single-asterisk emphasis only when it is really there', () => {
    expect(hasSingleAsteriskEmphasis(LING_DESCRIPTION)).toBe(true);
    expect(hasSingleAsteriskEmphasis('**bold only**')).toBe(false);
    expect(hasSingleAsteriskEmphasis('no markup at all')).toBe(false);
    expect(hasSingleAsteriskEmphasis(undefined)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* lintCatalog                                                         */
/* ------------------------------------------------------------------ */

describe('lintCatalog', () => {
  it('catches all four upstream defect classes', () => {
    const issues = lintCatalog(fixtureModels());
    const counts = summarizeLint(issues);

    expect(counts['single-asterisk-markdown']).toBe(1);
    expect(counts['missing-vendor-prefix']).toBe(3);
    expect(counts['tilde-prefixed-id']).toBe(1);
    expect(counts['truncated-description']).toBe(2);
    expect(counts['empty-description']).toBe(1);
    expect(counts['missing-context-length']).toBe(1);
    expect(issues).toHaveLength(9);
  });

  it('pins the ling-3.0-flash markdown defect to that model', () => {
    const issues = lintCatalog(fixtureModels());
    const markdown = issues.filter((issue) => issue.issue === 'single-asterisk-markdown');
    expect(markdown).toHaveLength(1);
    expect(markdown[0]?.modelId).toBe('inclusionai/ling-3.0-flash');
    expect(markdown[0]?.detail).toContain('**Ling-3.0-flash**');
  });

  it('does not flag a well-formed model', () => {
    const issues = lintCatalog(fixtureModels()).filter((i) => i.modelId === 'tencent/hy3:free');
    expect(issues).toEqual([]);
  });

  it('reports the alias id with its concrete form', () => {
    const issue = lintCatalog(fixtureModels()).find((i) => i.issue === 'tilde-prefixed-id');
    expect(issue?.modelId).toBe('~deepseek/deepseek-v4-flash-latest');
    expect(issue?.detail).toContain('deepseek/deepseek-v4-flash-latest');
  });

  it('handles an empty catalog', () => {
    expect(lintCatalog([])).toEqual([]);
    expect(formatLintReport([], 0)).toContain('no metadata issues');
  });
});

/* ------------------------------------------------------------------ */
/* selection + formatting                                              */
/* ------------------------------------------------------------------ */

describe('filterFree / findModel / formatting', () => {
  it('returns only :free ids, widest context first', () => {
    const free = filterFree(fixtureModels());
    expect(free.map((m) => m.id)).toEqual([
      'nvidia/nemotron-3-ultra-550b-a55b:free',
      'tencent/hy3:free',
    ]);
  });

  it('resolves ids exactly, case-insensitively and by unique substring', () => {
    const models = fixtureModels();
    expect(findModel(models, 'tencent/hy3:free')?.id).toBe('tencent/hy3:free');
    expect(findModel(models, 'TENCENT/HY3:FREE')?.id).toBe('tencent/hy3:free');
    expect(findModel(models, 'ling-3.0-flash')?.id).toBe('inclusionai/ling-3.0-flash');
    expect(findModel(models, 'nope')).toBeUndefined();
    expect(findModel(models, '')).toBeUndefined();
  });

  it('formats a model info block with the repaired description', () => {
    const model = fixtureModels().find((m) => m.id === 'inclusionai/ling-3.0-flash');
    expect(model).toBeDefined();
    const text = formatModelInfo(model as NonNullable<typeof model>);
    expect(text).toContain('id: `inclusionai/ling-3.0-flash`');
    expect(text).toContain('context: 131K tokens');
    expect(text).toContain('max completion: 32K tokens');
    expect(text).toContain('$0.15/M');
    expect(text).toContain('**Ling-3.0-flash**');
    expect(text).toContain('free: no');
  });

  it('formats free listings and lint reports for chat', () => {
    const free = filterFree(fixtureModels());
    const list = formatFreeList(free);
    expect(list).toContain('2 free model(s)');
    expect(list).toContain('1M ctx');

    const report = formatLintReport(lintCatalog(fixtureModels()), FIXTURE_MODEL_COUNT, 2);
    expect(report).toContain('9 issue(s) across 6 models');
    expect(report).toContain('and 7 more');
  });
});

/* ------------------------------------------------------------------ */
/* CatalogClient                                                       */
/* ------------------------------------------------------------------ */

describe('CatalogClient', () => {
  const apiKey = 'test-key-1234567890abcdefghij';

  it('fetches, caches in memory and in scoped storage', async () => {
    const storage = new MemoryScopedStorage();
    const fake = makeFetch(() => jsonResponse(MODELS_FIXTURE));
    let clock = 1_000_000;
    const client = new CatalogClient({
      apiKey,
      fetch: fake.fetch,
      storage,
      ttlSeconds: 60,
      now: () => clock,
    });

    const first = await client.getModels();
    expect(first.source).toBe('network');
    expect(first.models).toHaveLength(FIXTURE_MODEL_COUNT);

    const second = await client.getModels();
    expect(second.source).toBe('memory-cache');
    expect(fake.calls).toHaveLength(1);
    expect(storage.entries.has(CACHE_KEY)).toBe(true);

    // a fresh client with the same storage must not hit the network
    const warm = new CatalogClient({ apiKey, fetch: fake.fetch, storage, ttlSeconds: 60, now: () => clock });
    expect((await warm.getModels()).source).toBe('storage-cache');
    expect(fake.calls).toHaveLength(1);

    // ...until the TTL lapses
    clock += 61_000;
    expect((await client.getModels()).source).toBe('network');
    expect(fake.calls).toHaveLength(2);
  });

  it('sends the bearer token and asks the right endpoint', async () => {
    const fake = makeFetch(() => jsonResponse(MODELS_FIXTURE));
    const client = new CatalogClient({ apiKey, fetch: fake.fetch, baseUrl: 'https://gw.test/v1/' });
    await client.getModels();
    expect(fake.calls[0]?.url).toBe('https://gw.test/v1/models');
    expect(fake.calls[0]?.init?.headers?.['authorization']).toBe(`Bearer ${apiKey}`);
  });

  it('collapses concurrent refreshes into one request', async () => {
    const fake = makeFetch(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return jsonResponse(MODELS_FIXTURE);
    });
    const client = new CatalogClient({ apiKey, fetch: fake.fetch });
    const [a, b, c] = await Promise.all([client.getModels(), client.getModels(), client.getModels()]);
    expect(fake.calls).toHaveLength(1);
    expect(a.models).toHaveLength(FIXTURE_MODEL_COUNT);
    expect(b.models).toHaveLength(FIXTURE_MODEL_COUNT);
    expect(c.models).toHaveLength(FIXTURE_MODEL_COUNT);
  });

  it('turns every failure into a readable error', async () => {
    const missingKey = new CatalogClient({ fetch: makeFetch(() => jsonResponse({})).fetch });
    await expect(missingKey.getModels()).rejects.toThrow(/KILO_API_KEY is not set/);

    const badJson = new CatalogClient({ apiKey, fetch: makeFetch(() => jsonResponse('<html>502</html>')).fetch });
    await expect(badJson.getModels()).rejects.toThrow(/not valid JSON/);

    const empty = new CatalogClient({ apiKey, fetch: makeFetch(() => jsonResponse({ data: [] })).fetch });
    await expect(empty.getModels()).rejects.toThrow(/no usable model entries/);

    const offline = new CatalogClient({
      apiKey,
      fetch: makeFetch(() => {
        throw new Error('fetch failed: ECONNREFUSED');
      }).fetch,
    });
    await expect(offline.getModels()).rejects.toThrow(/ECONNREFUSED/);

    const timedOut = new CatalogClient({
      apiKey,
      timeoutMs: 1234,
      fetch: makeFetch(() => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }).fetch,
    });
    await expect(timedOut.getModels()).rejects.toThrow(/timed out after 1234ms/);
  });

  it('never echoes the credential in an error message', async () => {
    const client = new CatalogClient({
      apiKey,
      fetch: makeFetch(() =>
        jsonResponse(`{"message":"bad auth for Bearer ${apiKey}"}`, 401),
      ).fetch,
    });
    const error = await client.getModels().catch((err: unknown) => err);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toContain('HTTP 401');
    expect(message).not.toContain(apiKey);
    expect(message).toContain('[REDACTED]');
  });

  it('serves stale cache when a refresh fails', async () => {
    const storage = new MemoryScopedStorage();
    let clock = 5_000_000;
    let fail = false;
    const fake = makeFetch(() => {
      if (fail) throw new Error('gateway down');
      return jsonResponse(MODELS_FIXTURE);
    });
    const client = new CatalogClient({ apiKey, fetch: fake.fetch, storage, ttlSeconds: 10, now: () => clock });

    expect((await client.getModels()).source).toBe('network');
    fail = true;
    clock += 11_000;
    const stale = await client.getModels();
    expect(stale.source).toBe('stale-cache');
    expect(stale.models).toHaveLength(FIXTURE_MODEL_COUNT);
    expect(stale.warning).toContain('gateway down');
  });

  it('ignores a corrupt storage payload instead of crashing', async () => {
    const storage = new MemoryScopedStorage();
    storage.entries.set(CACHE_KEY, { nonsense: true });
    const fake = makeFetch(() => jsonResponse(MODELS_FIXTURE));
    const client = new CatalogClient({ apiKey, fetch: fake.fetch, storage });
    expect((await client.getModels()).source).toBe('network');
  });
});

/* ------------------------------------------------------------------ */
/* probing                                                             */
/* ------------------------------------------------------------------ */

describe('probing', () => {
  const apiKey = 'test-key-1234567890abcdefghij';

  it('treats HTTP 200 with an error body as a failure', () => {
    const paid = interpretCompletion('anthropic/claude-opus-5', {
      error: { title: 'Paid Model - Credits Required', message: 'Add credits to continue.' },
      error_type: 'usage_limit_exceeded',
    });
    expect(paid.ok).toBe(false);
    expect(paid.reason).toContain('Paid Model - Credits Required');
    expect(paid.reason).toContain('usage_limit_exceeded');
  });

  it('accepts a real completion and rejects an empty one', () => {
    const good = interpretCompletion('tencent/hy3:free', {
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
    });
    expect(good.ok).toBe(true);
    expect(good.sample).toBe('ok');

    expect(interpretCompletion('x/y', { choices: [] }).ok).toBe(false);
    expect(interpretCompletion('x/y', {}).ok).toBe(false);
    expect(interpretCompletion('x/y', null).ok).toBe(false);
  });

  it('probes serially and reports the paid-model rejection per model', async () => {
    const fake = makeFetch((_url, init) => {
      const body = JSON.parse(init?.body ?? '{}') as { model?: string };
      if (body.model === 'tencent/hy3:free') {
        return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
      }
      return jsonResponse({
        error: { title: 'Paid Model - Credits Required' },
        error_type: 'usage_limit_exceeded',
      });
    });
    const client = new CatalogClient({ apiKey, fetch: fake.fetch });
    const results = await client.probeModels(['tencent/hy3:free', 'anthropic/claude-opus-5']);

    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]?.url).toContain('/chat/completions');
    expect(results[0]?.ok).toBe(true);
    expect(results[1]?.ok).toBe(false);
    expect(results[1]?.reason).toContain('Credits Required');
  });

  it('respects the limit and the global time budget', async () => {
    let clock = 0;
    const fake = makeFetch(() => {
      clock += 1000;
      return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
    });
    const client = new CatalogClient({ apiKey, fetch: fake.fetch, now: () => clock });
    const results = await client.probeModels(['a/1', 'b/2', 'c/3', 'd/4'], {
      limit: 3,
      budgetMs: 1500,
    });

    expect(results).toHaveLength(3);
    expect(fake.calls.length).toBeLessThan(3);
    expect(results.some((r) => r.reason === 'skipped: time budget exhausted')).toBe(true);
  });
});

describe('probe result interpretation', () => {
  it('notes an empty completion instead of calling it broken', () => {
    const result = interpretCompletion('tencent/hy3:free', {
      choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '' } }],
    });
    expect(result.ok).toBe(true);
    expect(result.sample).toContain('finish_reason=length');
  });

  it('falls back to reasoning text when content is empty', () => {
    const result = interpretCompletion('tencent/hy3:free', {
      choices: [{ message: { role: 'assistant', content: '', reasoning: 'thinking about ok' } }],
    });
    expect(result.ok).toBe(true);
    expect(result.sample).toContain('thinking about ok');
  });
});

/* ------------------------------------------------------------------ */
/* plugin wiring                                                       */
/* ------------------------------------------------------------------ */

describe('plugin wiring', () => {
  it('registers four commands and degrades to a readable line without credentials', async () => {
    const previousKey = process.env['KILO_API_KEY'];
    delete process.env['KILO_API_KEY'];

    const commands = new Map<string, PluginCommand>();
    const context = {
      pluginId: 'model-catalog',
      logger: createNullLogger(),
      storage: new MemoryScopedStorage(),
      config: { cacheTtlSeconds: 60, probeEnabled: false },
      registerCommand: (command: PluginCommand) => {
        commands.set(command.name, command);
      },
    } as unknown as PluginContext;

    const commandContext = {
      args: [],
      raw: '',
      message: {} as unknown as CommandContext['message'],
      reply: async () => {},
    } as CommandContext;

    try {
      await plugin.onLoad?.(context);
      expect([...commands.keys()].sort()).toEqual(['freemodels', 'lint', 'modelinfo', 'probefree']);

      const free = await commands.get('freemodels')?.execute(commandContext);
      expect(String(free)).toContain('KILO_API_KEY is not set');

      const info = await commands.get('modelinfo')?.execute(commandContext);
      expect(String(info)).toContain('Usage');

      const probe = await commands.get('probefree')?.execute(commandContext);
      expect(String(probe)).toContain('disabled');

      const lint = await commands.get('lint')?.execute(commandContext);
      expect(String(lint)).toContain('Could not read the model catalog');
    } finally {
      await plugin.onUnload?.();
      if (previousKey !== undefined) process.env['KILO_API_KEY'] = previousKey;
    }
  });
});
