/**
 * Unit tests for the kilo provider.
 *
 * Every test drives an INJECTED fetch - nothing here touches the network, and
 * no real API key appears anywhere in this file.
 *
 * Run from the project root (the root vitest config only globs src/):
 *   npx vitest run --config plugins/kilo-provider/vitest.config.ts
 */

import { describe, expect, it, vi } from 'vitest';

import { AIError } from '../../src/ai/types.js';
import type { AIConfig } from '../../src/config/schema.js';
import { createNullLogger, type Logger } from '../../src/core/logger.js';
import { createRegistries } from '../../src/core/registries.js';
import type { ChatMessage } from '../../src/core/types.js';
import type { PluginContext } from '../../src/plugins/types.js';
import plugin from './index.js';
import {
  KILO_DEFAULT_BASE_URL,
  KILO_DEFAULT_MODEL,
  KiloProvider,
  classifyGatewayError,
  extractGatewayError,
  resolveKiloSettings,
  type KiloSettings,
} from './provider.js';

/* ------------------------------------------------------------- fixtures */

const messages: ChatMessage[] = [{ role: 'user', content: 'reply with exactly KILO_OK' }];

function settings(overrides: Partial<KiloSettings> = {}): KiloSettings {
  return {
    baseUrl: KILO_DEFAULT_BASE_URL,
    model: KILO_DEFAULT_MODEL,
    apiKey: 'test-key-not-real',
    temperature: 0.8,
    timeoutMs: 5000,
    retries: 0,
    retryBaseDelayMs: 1,
    stream: false,
    ...overrides,
  };
}

interface LogLine {
  obj: unknown;
  msg?: string;
}

function recordingLogger(): { logger: Logger; warns: LogLine[] } {
  const warns: LogLine[] = [];
  const noop = (): void => {};
  const logger: Logger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: (obj: unknown, msg?: string) => {
      warns.push({ obj, msg });
    },
    error: noop,
    fatal: noop,
    child: () => logger,
  };
  return { logger, warns };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** A fetch that resolves the queued responses in order. */
function queuedFetch(responses: Response[]): { fetchImpl: typeof fetch; calls: () => number } {
  let index = 0;
  const spy = vi.fn(async () => {
    const res = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (!res) throw new Error('no queued response');
    return res;
  });
  return { fetchImpl: spy as unknown as typeof fetch, calls: () => spy.mock.calls.length };
}

/** A fetch that never settles until its signal aborts. */
function hangingFetch(): typeof fetch {
  return vi.fn(
    (_input: unknown, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const fail = (): void => {
          const error = new Error('The operation was aborted');
          error.name = 'AbortError';
          reject(error);
        };
        if (signal?.aborted) {
          fail();
          return;
        }
        signal?.addEventListener('abort', fail, { once: true });
      }),
  ) as unknown as typeof fetch;
}

async function captureError(promise: Promise<unknown>): Promise<AIError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AIError) return error;
    throw new Error(`expected an AIError, got ${String(error)}`);
  }
  throw new Error('expected the call to reject');
}

/* ------------------------------------------- quirk 2: errors as HTTP 200 */

describe('gateway errors disguised as HTTP 200', () => {
  const creditsBody = {
    error: {
      title: 'Paid Model - Credits Required',
      message: 'Add credits to continue, or switch to a free model',
      balance: -0.008184,
      buyCreditsUrl: 'https://app.kilo.ai/billing',
    },
    error_type: 'usage_limit_exceeded',
  };

  it('maps the object-shaped credits envelope to a non-retryable auth error', async () => {
    const { fetchImpl, calls } = queuedFetch([jsonResponse(creditsBody, 200)]);
    const { logger } = recordingLogger();
    const provider = new KiloProvider(settings({ retries: 3 }), { logger, fetchImpl });

    const error = await captureError(provider.chat(messages));

    expect(error.kind).toBe('auth');
    expect(error.retryable).toBe(false);
    expect(error.status).toBe(200);
    expect(error.attempts).toBe(1);
    expect(error.message).toContain('usage_limit_exceeded');
    expect(error.message).toContain('Credits Required');
    expect(error.message).toContain('balance -0.008184');
    // retries=3 but a credit failure must never be retried
    expect(calls()).toBe(1);
  });

  it('parses the string-shaped error envelope (invalid_path, a real HTTP 400)', async () => {
    const body = { error: 'Invalid path', error_type: 'invalid_path', status: 400 };
    const { fetchImpl, calls } = queuedFetch([jsonResponse(body, 400)]);
    const { logger } = recordingLogger();
    const provider = new KiloProvider(settings({ retries: 3 }), { logger, fetchImpl });

    const error = await captureError(provider.chat(messages));

    expect(error.kind).toBe('bad_request');
    expect(error.retryable).toBe(false);
    expect(error.status).toBe(400);
    expect(error.message).toContain('invalid_path');
    expect(error.message).toContain('Invalid path');
    expect(calls()).toBe(1);
  });

  it('never dereferences choices[0] blindly when the body has neither choices nor an error', async () => {
    const { fetchImpl } = queuedFetch([jsonResponse({ id: 'x' }, 200)]);
    const { logger } = recordingLogger();
    const provider = new KiloProvider(settings(), { logger, fetchImpl });

    const error = await captureError(provider.chat(messages));

    expect(error).toBeInstanceOf(AIError);
    expect(error.kind).toBe('unknown');
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('neither choices nor an error envelope');
  });

  it('extracts and classifies both envelope shapes', () => {
    const objectShape = extractGatewayError(creditsBody);
    expect(objectShape?.errorType).toBe('usage_limit_exceeded');
    expect(objectShape?.balance).toBeCloseTo(-0.008184);
    expect(classifyGatewayError(objectShape!)).toEqual({ kind: 'auth', retryable: false });

    const stringShape = extractGatewayError({ error: 'Invalid path', error_type: 'invalid_path' });
    expect(stringShape?.message).toBe('Invalid path');
    expect(classifyGatewayError(stringShape!)).toEqual({ kind: 'bad_request', retryable: false });

    expect(extractGatewayError({ choices: [] })).toBeUndefined();
  });
});

/* ---------------------------------------------- quirk 1: reasoning model */

describe('reasoning models', () => {
  it('returns a diagnosable answer (never an empty string) when only reasoning came back', async () => {
    const body = {
      model: 'tencent/hy3:free',
      choices: [
        {
          message: { content: null, reasoning: 'Let me think about what the user wants... '.repeat(4) },
          finish_reason: 'length',
        },
      ],
      usage: {
        prompt_tokens: 17,
        completion_tokens: 481,
        total_tokens: 498,
        completion_tokens_details: { reasoning_tokens: 474 },
      },
    };
    const { fetchImpl } = queuedFetch([jsonResponse(body, 200)]);
    const { logger, warns } = recordingLogger();
    const provider = new KiloProvider(settings(), { logger, fetchImpl });

    await expect(provider.chat(messages)).rejects.toMatchObject({
      kind: 'server',
      message: expect.stringContaining('reasoning chain consumed the token budget'),
    });

  });

  it('keeps reasoning out of content when the model does answer', async () => {
    const body = {
      model: 'tencent/hy3:free',
      choices: [
        {
          message: { content: 'KILO_OK', reasoning: 'The user asked for a literal token.' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 17, completion_tokens: 481, total_tokens: 498 },
    };
    const { fetchImpl } = queuedFetch([jsonResponse(body, 200)]);
    const { logger, warns } = recordingLogger();
    const provider = new KiloProvider(settings(), { logger, fetchImpl });

    const response = await provider.chat(messages);

    expect(response.content).toBe('KILO_OK');
    expect(response.reasoning).toBe('The user asked for a literal token.');
    expect(response.reasoningOnly).toBeUndefined();
    expect(response.finishReason).toBe('stop');
    expect(warns).toHaveLength(0);
  });
});

/* ------------------------------------------------------------- streaming */

describe('streaming', () => {
  it('streams delta.content only and never mixes delta.reasoning into the answer', async () => {
    const frames = [
      'data: {"model":"tencent/hy3:free","choices":[{"delta":{"reasoning":"thinking hard"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"KILO"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"_OK"},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":17,"completion_tokens":40,"total_tokens":57,"completion_tokens_details":{"reasoning_tokens":31}}}\n\n',
      'data: [DONE]\n\n',
    ];
    const { fetchImpl } = queuedFetch([sseResponse(frames)]);
    const { logger } = recordingLogger();
    const provider = new KiloProvider(settings({ stream: true }), { logger, fetchImpl });

    const deltas: string[] = [];
    const response = await provider.chat(messages, { stream: true, onDelta: (d) => deltas.push(d) });

    expect(deltas).toEqual(['KILO', '_OK']);
    expect(response.content).toBe('KILO_OK');
    expect(response.reasoning).toBe('thinking hard');
    expect(response.finishReason).toBe('stop');
    expect(response.usage).toEqual({ promptTokens: 17, completionTokens: 40, totalTokens: 57 });
    expect(response.reasoningTokens).toBe(31);
  });

  it('surfaces an error frame arriving mid-stream as an AIError', async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
      'data: {"error":{"message":"Add credits to continue"},"error_type":"usage_limit_exceeded"}\n\n',
    ];
    const { fetchImpl } = queuedFetch([sseResponse(frames)]);
    const { logger } = recordingLogger();
    const provider = new KiloProvider(settings({ stream: true }), { logger, fetchImpl });

    const error = await captureError(provider.chat(messages, { stream: true, onDelta: () => {} }));

    expect(error.kind).toBe('auth');
    expect(error.retryable).toBe(false);
  });
});

/* ------------------------------------------------------- retry behaviour */

describe('retry policy', () => {
  it('retries a 5xx and succeeds on the next attempt', async () => {
    const ok = {
      model: 'tencent/hy3:free',
      choices: [{ message: { content: 'KILO_OK' }, finish_reason: 'stop' }],
    };
    const { fetchImpl, calls } = queuedFetch([jsonResponse({ error: 'boom' }, 503), jsonResponse(ok, 200)]);
    const { logger } = recordingLogger();
    const provider = new KiloProvider(settings({ retries: 2 }), { logger, fetchImpl });

    const response = await provider.chat(messages);

    expect(response.content).toBe('KILO_OK');
    expect(calls()).toBe(2);
  });

  it('never retries an auth failure', async () => {
    const { fetchImpl, calls } = queuedFetch([jsonResponse({ error: 'nope' }, 401)]);
    const { logger } = recordingLogger();
    const provider = new KiloProvider(settings({ retries: 3 }), { logger, fetchImpl });

    const error = await captureError(provider.chat(messages));

    expect(error.kind).toBe('auth');
    expect(calls()).toBe(1);
  });

  it('reports a timeout as a retryable timeout AIError and stops after the budget', async () => {
    const fetchImpl = hangingFetch();
    const { logger } = recordingLogger();
    const provider = new KiloProvider(settings({ timeoutMs: 20, retries: 1 }), { logger, fetchImpl });

    const error = await captureError(provider.chat(messages));

    expect(error.kind).toBe('timeout');
    expect(error.retryable).toBe(true);
    expect(error.attempts).toBe(2);
    expect(error.message).toContain('timed out after 20ms');
  });

  it('honours an external abort signal without retrying', async () => {
    const fetchImpl = hangingFetch();
    const { logger } = recordingLogger();
    const provider = new KiloProvider(settings({ retries: 3, timeoutMs: 5000 }), { logger, fetchImpl });
    const controller = new AbortController();
    controller.abort();

    const error = await captureError(provider.chat(messages, { signal: controller.signal }));

    expect(error.kind).toBe('aborted');
    expect(error.retryable).toBe(false);
    expect(error.attempts).toBe(1);
  });
});

/* --------------------------------------------------- key handling/health */

describe('missing API key', () => {
  it('fails the call with a clear auth error and never hits the network', async () => {
    const { fetchImpl, calls } = queuedFetch([jsonResponse({}, 200)]);
    const { logger } = recordingLogger();
    const provider = new KiloProvider(settings({ apiKey: '' }), { logger, fetchImpl });

    const error = await captureError(provider.chat(messages));

    expect(error.kind).toBe('auth');
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('KILO_API_KEY');
    expect(calls()).toBe(0);
  });

  it('health() reports the missing key instead of throwing', async () => {
    const { fetchImpl } = queuedFetch([jsonResponse({}, 200)]);
    const { logger } = recordingLogger();
    const provider = new KiloProvider(settings({ apiKey: '' }), { logger, fetchImpl });

    await expect(provider.health()).resolves.toEqual({
      ok: false,
      detail: expect.stringContaining('KILO_API_KEY is not set') as unknown as string,
    });
  });
});

describe('health()', () => {
  it('reports reachability from GET /models and says key validity is unverifiable', async () => {
    const { fetchImpl } = queuedFetch([jsonResponse({ data: [{ id: 'a' }, { id: 'b' }] }, 200)]);
    const { logger } = recordingLogger();
    const provider = new KiloProvider(settings(), { logger, fetchImpl });

    const health = await provider.health();

    expect(health.ok).toBe(true);
    expect(health.detail).toContain('2 models');
    expect(health.detail).toContain('NOT verifiable');
  });

  it('never throws on a transport failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const { logger } = recordingLogger();
    const provider = new KiloProvider(settings(), { logger, fetchImpl });

    await expect(provider.health()).resolves.toEqual({ ok: false, detail: 'ECONNREFUSED' });
  });
});

/* ------------------------------------------------------------- settings */

function frameworkDefaultConfig(overrides: Partial<AIConfig> = {}): AIConfig {
  return {
    provider: 'kilo',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    temperature: 0.8,
    timeoutMs: 60000,
    retries: 2,
    retryBaseDelayMs: 500,
    stream: false,
    fallbackReply: 'nope',
    options: {},
    ...overrides,
  } as AIConfig;
}

describe('resolveKiloSettings', () => {
  it('applies kilo defaults when the bot yaml only carries framework defaults', () => {
    const resolved = resolveKiloSettings(frameworkDefaultConfig(), {}, {});

    expect(resolved.baseUrl).toBe(KILO_DEFAULT_BASE_URL);
    expect(resolved.model).toBe(KILO_DEFAULT_MODEL);
  });

  it('honors an explicit compatible Kilo gateway URL', () => {
    const resolved = resolveKiloSettings(frameworkDefaultConfig({ baseUrl: 'https://apx.ntbsd.eu.org/v1' }), {}, {});
    expect(resolved.baseUrl).toBe('https://apx.ntbsd.eu.org/v1');
  });

  it('lets plugin.json config override the kilo defaults', () => {
    const resolved = resolveKiloSettings(
      frameworkDefaultConfig(),
      { defaultModel: 'nvidia/nemotron-3-super-120b-a12b:free', timeoutMs: 90000 },
      {},
    );

    expect(resolved.model).toBe('nvidia/nemotron-3-super-120b-a12b:free');
    expect(resolved.timeoutMs).toBe(90000);
  });

  it('lets an explicit bot yaml value beat plugin.json', () => {
    const resolved = resolveKiloSettings(
      frameworkDefaultConfig({ model: 'stepfun/step-3.7-flash:free' }),
      { defaultModel: 'tencent/hy3:free' },
      {},
    );

    expect(resolved.model).toBe('stepfun/step-3.7-flash:free');
  });

  it('gives ai.options the last word', () => {
    const resolved = resolveKiloSettings(
      frameworkDefaultConfig({ model: 'stepfun/step-3.7-flash:free', options: { model: 'cohere/north-mini-code:free' } }),
      { defaultModel: 'tencent/hy3:free' },
      {},
    );

    expect(resolved.model).toBe('cohere/north-mini-code:free');
  });

  it('reads the key from KILO_API_KEY and never from plugin.json', () => {
    const fromEnv = resolveKiloSettings(frameworkDefaultConfig(), { apiKey: 'should-be-ignored' }, {
      KILO_API_KEY: 'env-key',
    });
    expect(fromEnv.apiKey).toBe('env-key');

    const fromConfig = resolveKiloSettings(frameworkDefaultConfig({ apiKey: 'cfg-key' }), {}, {
      KILO_API_KEY: 'env-key',
    });
    expect(fromConfig.apiKey).toBe('cfg-key');

    const none = resolveKiloSettings(frameworkDefaultConfig(), { apiKey: 'should-be-ignored' }, {});
    expect(none.apiKey).toBe('');
  });
});

/* ---------------------------------------------------- plugin registration */

describe('plugin registration (no src/ changes required)', () => {
  function fakeContext(registries = createRegistries()): { ctx: PluginContext; registries: typeof registries } {
    const ctx = {
      pluginId: 'kilo-provider',
      logger: createNullLogger(),
      config: { baseUrl: KILO_DEFAULT_BASE_URL, defaultModel: KILO_DEFAULT_MODEL },
      botConfig: { ai: { apiKey: '' } },
      registry: registries,
    } as unknown as PluginContext;
    return { ctx, registries };
  }

  it('registers a working kilo factory and is reaped on unload', async () => {
    const { ctx, registries } = fakeContext();

    await plugin.onLoad?.(ctx);

    expect(registries.providers.has('kilo')).toBe(true);
    const entry = registries.providers.list().find((e) => e.name === 'kilo');
    expect(entry?.source).toBe('plugin:kilo-provider');

    const factory = registries.providers.require('kilo');
    const provider = factory(frameworkDefaultConfig({ apiKey: 'test-key-not-real' }), {
      logger: createNullLogger(),
      fetchImpl: queuedFetch([
        jsonResponse(
          { model: 'tencent/hy3:free', choices: [{ message: { content: 'KILO_OK' }, finish_reason: 'stop' }] },
          200,
        ),
      ]).fetchImpl,
    });

    expect(provider.name).toBe('kilo');
    expect(provider.model).toBe(KILO_DEFAULT_MODEL);
    await expect(provider.chat(messages)).resolves.toMatchObject({ content: 'KILO_OK' });

    // What the PluginManager does on unload.
    expect(registries.providers.unregisterSource('plugin:kilo-provider')).toEqual(['kilo']);
    expect(registries.providers.has('kilo')).toBe(false);
  });

  it('loads without KILO_API_KEY - only the call fails, not the load', async () => {
    const { ctx, registries } = fakeContext();
    const previous = process.env.KILO_API_KEY;
    delete process.env.KILO_API_KEY;

    try {
      await plugin.onLoad?.(ctx);
      expect(registries.providers.has('kilo')).toBe(true);

      const provider = registries.providers.require('kilo')(frameworkDefaultConfig(), {
        logger: createNullLogger(),
        fetchImpl: queuedFetch([jsonResponse({}, 200)]).fetchImpl,
      });
      const error = await captureError(provider.chat(messages));
      expect(error.kind).toBe('auth');
      expect(error.message).toContain('KILO_API_KEY');
    } finally {
      if (previous !== undefined) process.env.KILO_API_KEY = previous;
    }
  });
});
