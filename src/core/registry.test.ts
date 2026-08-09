/**
 * Open/closed principle regression tests.
 *
 * These guard the promise that extending MohoBot never requires editing src/.
 * If someone reintroduces a hard-coded if/else for providers, gateways,
 * storage drivers or memory adapters, these tests fail.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNullLogger } from './logger.js';
import { AIConfigSchema } from './../config/schema.js';
import { createRegistries, type Registries } from './registries.js';
import { Registry, RegistryError } from './registry.js';

describe('Registry', () => {
  it('registers and resolves a factory', () => {
    const r = new Registry<() => string>('thing');
    r.register('a', () => 'A', { source: 'test' });
    expect(r.require('a')()).toBe('A');
    expect(r.has('a')).toBe(true);
  });

  it('is case- and whitespace-insensitive', () => {
    const r = new Registry<number>('thing');
    r.register('  MiXeD  ', 1);
    expect(r.get('mixed')).toBe(1);
  });

  it('refuses a silent overwrite but allows an explicit override', () => {
    const r = new Registry<number>('thing');
    r.register('dup', 1, { source: 'first' });
    expect(() => r.register('dup', 2)).toThrow(RegistryError);
    expect(() => r.register('dup', 2)).toThrow(/already registered/);
    r.register('dup', 3, { override: true });
    expect(r.get('dup')).toBe(3);
  });

  it('rejects an empty name', () => {
    const r = new Registry<number>('thing');
    expect(() => r.register('   ', 1)).toThrow(RegistryError);
  });

  it('lists what IS available when a lookup misses', () => {
    const r = new Registry<number>('AI provider');
    r.register('openai', 1);
    r.register('mock', 2);
    expect(() => r.require('nope')).toThrow(/unknown AI provider/);
    expect(() => r.require('nope')).toThrow(/mock, openai/);
  });

  it('resolve() degrades to a fallback instead of throwing', () => {
    const r = new Registry<string>('driver');
    r.register('sqlite', 'S');
    expect(r.resolve('postgres', 'sqlite', createNullLogger())).toBe('S');
  });

  it('unregisters every entry from one source (plugin teardown)', () => {
    const r = new Registry<number>('thing');
    r.register('keep', 1, { source: 'builtin' });
    r.register('x', 2, { source: 'plugin:p' });
    r.register('y', 3, { source: 'plugin:p' });

    expect(r.unregisterSource('plugin:p').sort()).toEqual(['x', 'y']);
    expect(r.names()).toEqual(['keep']);
  });

  it('reports the source of each entry', () => {
    const r = new Registry<number>('thing');
    r.register('a', 1, { source: 'extension:demo', description: 'demo' });
    expect(r.list()[0]).toMatchObject({ name: 'a', source: 'extension:demo', description: 'demo' });
  });

  it('needsKey delegates to the entry hook when present', () => {
    const r = new Registry<unknown>('AI provider');
    r.register('kilo', null, {
      source: 'plugin:kilo',
      needsKey: (c: { apiKey?: string }) => !c.apiKey && !process.env.KILO_API_KEY,
    });
    vi.stubEnv('KILO_API_KEY', 'present');
    expect(r.needsKey('kilo', AIConfigSchema.parse({ apiKey: '' }))).toBe(false);
    vi.stubEnv('KILO_API_KEY', '');
    expect(r.needsKey('kilo', AIConfigSchema.parse({ apiKey: '' }))).toBe(true);
    expect(r.needsKey('kilo', AIConfigSchema.parse({ apiKey: 'x' }))).toBe(false);
  });

  it('needsKey falls back to the default rule when no hook', () => {
    const r = new Registry<unknown>('AI provider');
    r.register('plain', null);
    expect(r.needsKey('plain', AIConfigSchema.parse({ apiKey: '' }))).toBe(true);
    expect(r.needsKey('plain', AIConfigSchema.parse({ apiKey: 'x' }))).toBe(false);
  });

  it('needsKey throws on an unknown name', () => {
    const r = new Registry<unknown>('AI provider');
    expect(() => r.needsKey('ghost', AIConfigSchema.parse({}))).toThrow(/unknown AI provider/);
  });
});

describe('open/closed guarantees', () => {
  it('exposes exactly the four documented extension points', () => {
    const regs: Registries = createRegistries();
    expect(Object.keys(regs).sort()).toEqual(['gateways', 'memories', 'providers', 'storages']);
  });

  it('accepts a third-party AI provider with no core change', async () => {
    const r = createRegistries();
    r.providers.register(
      'my-llm',
      () => ({
        name: 'my-llm',
        model: 'x',
        async chat() {
          return { content: 'from a plugin', model: 'x', ms: 0 };
        },
        async health() {
          return { ok: true };
        },
      }),
      { source: 'plugin:demo' },
    );

    const provider = r.providers.require('my-llm')(
      { provider: 'my-llm' } as never,
      { logger: createNullLogger() },
    );
    await expect(provider.chat([], {})).resolves.toMatchObject({ content: 'from a plugin' });
  });

  it('accepts a third-party memory adapter with no core change', async () => {
    const r = createRegistries();
    r.memories.register(
      'vector',
      () => ({
        name: 'vector',
        async recall() {
          return [{ role: 'system', content: 'recalled' }];
        },
        async remember() {},
      }),
      { source: 'plugin:demo' },
    );

    const memory = r.memories.require('vector')({ botId: 'b', logger: createNullLogger(), options: {} });
    await expect(memory.recall({ botId: 'b', channelId: 'c', userId: 'u', query: 'q' })).resolves.toEqual([
      { role: 'system', content: 'recalled' },
    ]);
  });

  it('keeps registries isolated so one bot cannot corrupt another', () => {
    const a = createRegistries();
    const b = createRegistries();
    a.gateways.register('telegram', (() => ({})) as never);
    expect(a.gateways.has('telegram')).toBe(true);
    expect(b.gateways.has('telegram')).toBe(false);
  });
});
