import { describe, expect, it } from 'vitest';
import { MultiProviderRouter } from './multi-router.js';
import { createNullLogger } from '../core/logger.js';

describe('MultiProviderRouter', () => {
  it('routes a task to its selected profile and falls back after failure', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      if (url.startsWith('https://primary.test')) return new Response('down', { status: 503 });
      return new Response(JSON.stringify({ model: 'fallback', choices: [{ message: { content: 'ok' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    // Patch global fetch because profiles are intentionally independent clients.
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const router = new MultiProviderRouter({
        logger: createNullLogger(), defaultProfile: 'primary',
        profiles: {
          primary: { baseUrl: 'https://primary.test/v1', model: 'a', budget: { rpm: 0 } },
          fallback: { baseUrl: 'https://fallback.test/v1', model: 'b', budget: { rpm: 0 } },
        },
        routes: { planner: { primary: 'primary', fallback: 'fallback' } },
      });
      await expect(router.chat([], { task: 'planner' })).resolves.toMatchObject({ content: 'ok' });
      expect(calls.filter((url) => url.startsWith('https://primary.test'))).toHaveLength(3);
      expect(calls.at(-1)).toBe('https://fallback.test/v1/chat/completions');
    } finally { globalThis.fetch = original; }
  });
});
