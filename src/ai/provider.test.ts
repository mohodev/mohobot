import { describe, expect, it, vi } from 'vitest';

import { AIConfigSchema, type AIConfig } from '../config/schema.js';
import { createNullLogger } from '../core/logger.js';
import type { ChatMessage } from '../core/types.js';
import { MockProvider } from './mock.js';
import { OpenAICompatibleProvider, parseRetryAfter } from './openai-compatible.js';
import { AIError } from './types.js';

const logger = createNullLogger();
const messages: ChatMessage[] = [
  { role: 'system', content: 'you are a test bot' },
  { role: 'user', content: 'ping' },
];

function cfg(overrides: Partial<AIConfig> = {}): AIConfig {
  return AIConfigSchema.parse({
    baseUrl: 'https://api.example.test/v1',
    apiKey: 'test-key-123456',
    model: 'test-model',
    retryBaseDelayMs: 1,
    timeoutMs: 5000,
    retries: 2,
    ...overrides,
  });
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function completion(content: string): unknown {
  return {
    model: 'test-model',
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
  };
}

function abortError(): Error {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

describe('OpenAICompatibleProvider', () => {
  it('returns content, usage and duration on the happy path', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: unknown, init: unknown) => {
      calls.push({ url: String(url), init: init as RequestInit });
      return jsonResponse(completion('pong'));
    }) as unknown as typeof fetch;

    const provider = new OpenAICompatibleProvider(cfg(), { logger, fetchImpl, botId: 'b1' });
    const res = await provider.chat(messages);

    expect(res.content).toBe('pong');
    expect(res.model).toBe('test-model');
    expect(res.usage?.totalTokens).toBe(15);
    expect(res.finishReason).toBe('stop');
    expect(res.ms).toBeGreaterThanOrEqual(0);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.example.test/v1/chat/completions');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key-123456');
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(String(calls[0]?.init.body)) as { model: string; stream: boolean; max_tokens: number };
    expect(body.model).toBe('test-model');
    expect(body.stream).toBe(false);
  });

  it('omits the Authorization header when there is no api key', async () => {
    let seen: Record<string, string> = {};
    const fetchImpl = (async (_url: unknown, init: unknown) => {
      seen = (init as RequestInit).headers as Record<string, string>;
      return jsonResponse(completion('ok'));
    }) as unknown as typeof fetch;

    const provider = new OpenAICompatibleProvider(cfg({ apiKey: '' }), { logger, fetchImpl });
    await provider.chat(messages);
    expect(seen.Authorization).toBeUndefined();
  });

  it('retries a 500 and succeeds on the next attempt', async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      if (n === 1) return new Response('upstream exploded', { status: 500 });
      return jsonResponse(completion('recovered'));
    }) as unknown as typeof fetch;

    const errors: number[] = [];
    const provider = new OpenAICompatibleProvider(cfg(), {
      logger,
      fetchImpl,
      events: {
        emit: (event: string, payload: { attempt?: number }) => {
          if (event === 'ai:error' && typeof payload.attempt === 'number') errors.push(payload.attempt);
        },
      } as never,
    });

    const res = await provider.chat(messages);
    expect(res.content).toBe('recovered');
    expect(n).toBe(2);
    expect(errors).toEqual([1]);
  });

  it('gives up after exhausting retries and reports the attempt count', async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      return new Response('nope', { status: 503 });
    }) as unknown as typeof fetch;

    const provider = new OpenAICompatibleProvider(cfg({ retries: 2 }), { logger, fetchImpl });
    const err = await provider.chat(messages).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AIError);
    expect((err as AIError).kind).toBe('server');
    expect((err as AIError).status).toBe(503);
    expect((err as AIError).attempts).toBe(3);
    expect((err as AIError).retryable).toBe(true);
    expect(n).toBe(3);
  });

  it('never retries a 401 and classifies it as auth', async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      return new Response('invalid api key', { status: 401 });
    }) as unknown as typeof fetch;

    const provider = new OpenAICompatibleProvider(cfg({ retries: 3 }), { logger, fetchImpl });
    const err = (await provider.chat(messages).catch((e: unknown) => e)) as AIError;

    expect(err).toBeInstanceOf(AIError);
    expect(err.kind).toBe('auth');
    expect(err.status).toBe(401);
    expect(err.attempts).toBe(1);
    expect(err.retryable).toBe(false);
    expect(n).toBe(1);
  });

  it('never retries a 400 bad request', async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      return new Response('bad model', { status: 400 });
    }) as unknown as typeof fetch;

    const provider = new OpenAICompatibleProvider(cfg({ retries: 2 }), { logger, fetchImpl });
    const err = (await provider.chat(messages).catch((e: unknown) => e)) as AIError;
    expect(err.kind).toBe('bad_request');
    expect(n).toBe(1);
  });

  it('maps a timeout to kind=timeout using the AbortSignal', async () => {
    const fetchImpl = ((_url: unknown, init: unknown) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = (init as RequestInit).signal;
        if (!signal) return;
        if (signal.aborted) {
          reject(abortError());
          return;
        }
        signal.addEventListener('abort', () => reject(abortError()), { once: true });
      })) as unknown as typeof fetch;

    const provider = new OpenAICompatibleProvider(cfg({ timeoutMs: 20, retries: 0 }), { logger, fetchImpl });
    const err = (await provider.chat(messages).catch((e: unknown) => e)) as AIError;

    expect(err).toBeInstanceOf(AIError);
    expect(err.kind).toBe('timeout');
    expect(err.attempts).toBe(1);
    expect(err.retryable).toBe(true);
  });

  it('reports a per-call timeout override in the error message', async () => {
    const fetchImpl = ((_url: unknown, init: unknown) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = (init as RequestInit).signal;
        signal?.addEventListener('abort', () => reject(abortError()), { once: true });
      })) as unknown as typeof fetch;
    const provider = new OpenAICompatibleProvider(cfg({ timeoutMs: 5000, retries: 0 }), { logger, fetchImpl });
    const err = (await provider.chat(messages, { timeoutMs: 10 }).catch((e: unknown) => e)) as AIError;
    expect(err.kind).toBe('timeout');
    expect(err.message).toContain('10ms');
  });

  it('maps an external abort to kind=aborted and does not retry', async () => {
    const controller = new AbortController();
    let n = 0;
    const fetchImpl = ((_url: unknown, init: unknown) => {
      n += 1;
      return new Promise<Response>((_resolve, reject) => {
        const signal = (init as RequestInit).signal;
        signal?.addEventListener('abort', () => reject(abortError()), { once: true });
        setTimeout(() => controller.abort(), 5);
      });
    }) as unknown as typeof fetch;

    const provider = new OpenAICompatibleProvider(cfg({ timeoutMs: 5000, retries: 2 }), { logger, fetchImpl });
    const err = (await provider.chat(messages, { signal: controller.signal }).catch((e: unknown) => e)) as AIError;

    expect(err.kind).toBe('aborted');
    expect(err.retryable).toBe(false);
    expect(n).toBe(1);
  });

  it('honours Retry-After on a 429 and then succeeds', async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      if (n === 1) return new Response('slow down', { status: 429, headers: { 'retry-after': '0' } });
      return jsonResponse(completion('after the wait'));
    }) as unknown as typeof fetch;

    const provider = new OpenAICompatibleProvider(cfg(), { logger, fetchImpl });
    const started = Date.now();
    const res = await provider.chat(messages);

    expect(res.content).toBe('after the wait');
    expect(n).toBe(2);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('classifies an unrecovered 429 as rate_limit', async () => {
    const fetchImpl = (async () =>
      new Response('slow down', { status: 429, headers: { 'retry-after': '0' } })) as unknown as typeof fetch;
    const provider = new OpenAICompatibleProvider(cfg({ retries: 1 }), { logger, fetchImpl });
    const err = (await provider.chat(messages).catch((e: unknown) => e)) as AIError;
    expect(err.kind).toBe('rate_limit');
    expect(err.status).toBe(429);
    expect(err.attempts).toBe(2);
  });

  it('parses Retry-After in seconds and caps it at 30s', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter('600')).toBe(30_000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('not-a-date')).toBeUndefined();
  });

  it('maps a raw network failure to kind=network', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const provider = new OpenAICompatibleProvider(cfg({ retries: 1 }), { logger, fetchImpl });
    const err = (await provider.chat(messages).catch((e: unknown) => e)) as AIError;
    expect(err.kind).toBe('network');
    expect(err.attempts).toBe(2);
  });

  it('assembles streamed SSE deltas in order and skips malformed frames', async () => {
    const sse = [
      'data: {"model":"test-model","choices":[{"delta":{"role":"assistant","content":"Hel"}}]}',
      '',
      'data: this-is-not-json',
      '',
      ': a comment line',
      'data: {"choices":[{"delta":{"content":"lo, "}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"world"},"finish_reason":"stop"}],"usage":{"total_tokens":7}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');

    const fetchImpl = (async () =>
      new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;

    const deltas: string[] = [];
    const provider = new OpenAICompatibleProvider(cfg({ stream: true }), { logger, fetchImpl });
    const res = await provider.chat(messages, { stream: true, onDelta: (d) => deltas.push(d) });

    expect(deltas).toEqual(['Hel', 'lo, ', 'world']);
    expect(res.content).toBe('Hello, world');
    expect(res.finishReason).toBe('stop');
    expect(res.usage?.totalTokens).toBe(7);
  });

  it('falls back to a network error when a streaming body is missing', async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      body: null,
      headers: new Headers(),
      async text() {
        return '';
      },
    })) as unknown as typeof fetch;

    const provider = new OpenAICompatibleProvider(cfg({ stream: true, retries: 0 }), { logger, fetchImpl });
    const err = (await provider
      .chat(messages, { stream: true, onDelta: () => {} })
      .catch((e: unknown) => e)) as AIError;
    expect(err).toBeInstanceOf(AIError);
    expect(err.kind).toBe('network');
  });

  it('health() reports failure without throwing', async () => {
    const empty = new OpenAICompatibleProvider(cfg({ apiKey: '' }), { logger });
    await expect(empty.health()).resolves.toMatchObject({ ok: false });

    const boom = new OpenAICompatibleProvider(cfg(), {
      logger,
      fetchImpl: (async () => {
        throw new Error('dns exploded');
      }) as unknown as typeof fetch,
    });
    const res = await boom.health();
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('dns exploded');

    const okProvider = new OpenAICompatibleProvider(cfg(), {
      logger,
      fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
    });
    await expect(okProvider.health()).resolves.toEqual({ ok: true });
  });

  it('emits ai:request and ai:response around a successful call', async () => {
    const emit = vi.fn();
    const fetchImpl = (async () => jsonResponse(completion('hi'))) as unknown as typeof fetch;
    const provider = new OpenAICompatibleProvider(cfg(), {
      logger,
      fetchImpl,
      botId: 'bot-x',
      events: { emit } as never,
    });
    await provider.chat(messages);

    expect(emit).toHaveBeenCalledWith('ai:request', { botId: 'bot-x', model: 'test-model', messages: 2 });
    const responseCall = emit.mock.calls.find((c) => c[0] === 'ai:response');
    expect(responseCall?.[1]).toMatchObject({ botId: 'bot-x', model: 'test-model', tokens: 15 });
  });
});

describe('MockProvider', () => {
  it('is deterministic for the same input', async () => {
    const a = new MockProvider();
    const b = new MockProvider();
    const first = await a.chat(messages);
    const second = await b.chat(messages);

    expect(first.content).toBe('[mock] you said: ping');
    expect(second.content).toBe(first.content);
    expect(second.usage).toEqual(first.usage);
    expect(first.finishReason).toBe('stop');
  });

  it('truncates a very long user message', async () => {
    const provider = new MockProvider();
    const long = 'x'.repeat(500);
    const res = await provider.chat([{ role: 'user', content: long }]);
    expect(res.content).toBe(`[mock] you said: ${'x'.repeat(200)}...`);
  });

  it('cycles canned replies and streams them in chunks', async () => {
    const provider = new MockProvider({ replies: ['alpha reply that is long enough', 'beta'] });
    const deltas: string[] = [];
    const first = await provider.chat(messages, { onDelta: (d) => deltas.push(d) });

    expect(first.content).toBe('alpha reply that is long enough');
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.every((d) => d.length <= 12)).toBe(true);
    expect(deltas.join('')).toBe(first.content);

    const second = await provider.chat(messages);
    expect(second.content).toBe('beta');
    const third = await provider.chat(messages);
    expect(third.content).toBe('alpha reply that is long enough');
  });

  it('throws a retryable server AIError when failRate is 1', async () => {
    const provider = new MockProvider({ failRate: 1 });
    const err = (await provider.chat(messages).catch((e: unknown) => e)) as AIError;
    expect(err).toBeInstanceOf(AIError);
    expect(err.kind).toBe('server');
    expect(err.retryable).toBe(true);
  });

  it('health() is always ok', async () => {
    await expect(new MockProvider().health()).resolves.toMatchObject({ ok: true });
  });
});
