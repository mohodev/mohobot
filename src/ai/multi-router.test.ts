import { describe, expect, it } from 'vitest';
import { MultiProviderRouter } from './multi-router.js';
import { createNullLogger } from '../core/logger.js';

describe('MultiProviderRouter', () => {
  it('exposes narrow per-profile probe metadata without profile credentials', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;
    try {
      const router = new MultiProviderRouter({ logger:createNullLogger(), defaultProfile:'primary', profiles:{ primary:{baseUrl:'https://secret.test/v1',apiKey:'sk-secret',model:'vendor/model'} }, routes:{} });
      expect(router.profileIds()).toEqual(['primary']);
      const result = await router.probeProfile('primary');
      expect(result).toMatchObject({ id:'primary',model:'vendor/model',ok:true });
      expect(JSON.stringify(result)).not.toContain('secret.test');
      expect(JSON.stringify(result)).not.toContain('sk-secret');
    } finally { globalThis.fetch = original; }
  });

  it('tries an ordered fallback chain until a provider succeeds',async()=>{const calls:string[]=[];const original=globalThis.fetch;globalThis.fetch=(async(url:string)=>{calls.push(url);if(!url.startsWith('https://third.test'))return new Response('down',{status:503});return new Response(JSON.stringify({model:'third',choices:[{message:{content:'ok'}}]}),{status:200,headers:{'content-type':'application/json'}});})as typeof fetch;try{const router=new MultiProviderRouter({logger:createNullLogger(),defaultProfile:'first',profiles:{first:{baseUrl:'https://first.test/v1',model:'first',retries:0},second:{baseUrl:'https://second.test/v1',model:'second',retries:0},third:{baseUrl:'https://third.test/v1',model:'third',retries:0}},routes:{reply:{primary:'first',fallback:['second','third']}}});await expect(router.chat([{role:'user',content:'x'}])).resolves.toMatchObject({content:'ok'});expect(calls).toEqual(['https://first.test/v1/chat/completions','https://second.test/v1/chat/completions','https://third.test/v1/chat/completions']);}finally{globalThis.fetch=original;}});

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
