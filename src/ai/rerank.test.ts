import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNullLogger } from '../core/logger.js';
import type { RerankProvider } from '../memory/semantic-memory.js';
import { OpenAIRerankProvider } from './rerank.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function provider(overrides: Partial<ConstructorParameters<typeof OpenAIRerankProvider>[0]> = {}): OpenAIRerankProvider {
  return new OpenAIRerankProvider({
    baseUrl: 'https://rerank.example/v1/',
    apiKey: 'secret-key',
    model: 'test-reranker',
    timeoutMs: 100,
    ...overrides,
  }, createNullLogger());
}

describe('OpenAIRerankProvider', () => {
  it('satisfies semantic-memory RerankProvider and sends the common payload', async () => {
    const client: RerankProvider = provider();
    let request: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (_url, init) => {
      request = init;
      return new Response(JSON.stringify({
        results: [
          { index: 1, relevance_score: 0.91 },
          { index: 0, relevance_score: 0.42 },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    await expect(client.rerank({ query: 'hello', documents: ['a', 'b'], topK: 9 }))
      .resolves.toEqual([{ index: 1, score: 0.91 }, { index: 0, score: 0.42 }]);

    expect(globalThis.fetch).toHaveBeenCalledWith('https://rerank.example/v1/rerank', expect.any(Object));
    expect(request?.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer secret-key',
    });
    expect(JSON.parse(String(request?.body))).toEqual({
      model: 'test-reranker',
      query: 'hello',
      documents: ['a', 'b'],
      top_n: 2,
    });
  });

  it('accepts data/score response aliases and omits an empty bearer key', async () => {
    let headers: RequestInit['headers'];
    globalThis.fetch = vi.fn(async (_url, init) => {
      headers = init?.headers;
      return new Response(JSON.stringify({ data: [{ index: 0, score: 3.5 }] }), { status: 200 });
    }) as typeof fetch;

    const result = await provider({ apiKey: '' }).rerank({ query: 'q', documents: ['doc'], topK: 1 });
    expect(result).toEqual([{ index: 0, score: 3.5 }]);
    expect(headers).toEqual({ 'content-type': 'application/json' });
  });

  it.each([
    [{}, 'missing results'],
    [{ results: [{ index: 2, relevance_score: 1 }] }, 'invalid index'],
    [{ results: [{ index: 0, relevance_score: 'high' }] }, 'invalid score'],
    [{ results: [{ index: 0, score: 1 }, { index: 0, score: 0.5 }] }, 'duplicate index'],
  ])('rejects malformed responses: %s', async (payload, message) => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch;
    await expect(provider().rerank({ query: 'q', documents: ['a', 'b'], topK: 2 }))
      .rejects.toThrow(message);
  });

  it('propagates HTTP failures for caller-side degradation', async () => {
    globalThis.fetch = vi.fn(async () => new Response('busy', { status: 429 })) as typeof fetch;
    await expect(provider().rerank({ query: 'q', documents: ['a'], topK: 1 }))
      .rejects.toThrow('HTTP 429');
  });

  it('aborts after the configured timeout', async () => {
    globalThis.fetch = vi.fn(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })) as typeof fetch;

    await expect(provider({ timeoutMs: 5 }).rerank({ query: 'q', documents: ['a'], topK: 1 }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });

  it('returns no results without calling the endpoint for empty documents', async () => {
    globalThis.fetch = vi.fn() as typeof fetch;
    await expect(provider().rerank({ query: 'q', documents: [], topK: 3 })).resolves.toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
