/**
 * Regression tests for AI provider resolution.
 *
 * These lock the credential gate behaviour: createProvider delegates the
 * "do I need a key" decision to the registry entry's needsKey hook, so a
 * plugin provider can read a vendor-specific env var (KILO_API_KEY) instead of
 * being forced into the shared AI_API_KEY / mock path.
 *
 * If someone rewrites createProvider() back to cfg.apiKey.trim() === '' they
 * break the kilo provider and these tests fail.
 *
 * NOTE: createProvider() reads the process-wide `registries.providers`, so the
 * plugin providers must be registered there (and cleaned up by source).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerBuiltinProviders, createProvider, MOCK_PROVIDER } from './index.js';
import { registries } from '../core/registries.js';
import { AIConfigSchema, type AIConfig } from '../config/schema.js';
import { createNullLogger } from '../core/logger.js';

function cfg(overrides: Partial<AIConfig> = {}): AIConfig {
  return AIConfigSchema.parse({ provider: 'openai-compatible', model: 'x', apiKey: '', ...overrides });
}

function fakeProvider(name: string) {
  return () => ({
    name,
    model: 'x',
    async chat() {
      return { content: 'ok', model: 'x', ms: 0 };
    },
    async health() {
      return { ok: true };
    },
  });
}

const PLUGIN_SOURCE = 'plugin:resolution-test';

describe('createProvider credential gate', () => {
  const logger = createNullLogger();

  beforeEach(() => {
    registerBuiltinProviders();
  });

  afterEach(() => {
    registries.providers.unregisterSource(PLUGIN_SOURCE);
    vi.unstubAllEnvs();
  });

  it('falls back to mock when apiKey is empty and no plugin hook claims it', () => {
    const p = createProvider(cfg({ provider: 'openai-compatible', apiKey: '' }), { logger });
    expect(p.name).toBe(MOCK_PROVIDER);
  });

  it('forces mock when model === mock regardless of key', () => {
    const p = createProvider(cfg({ model: 'mock', apiKey: 'whatever' }), { logger });
    expect(p.name).toBe(MOCK_PROVIDER);
  });

  it('delegates the key check to the provider registry hook', () => {
    registries.providers.register('kilo', fakeProvider('kilo'), {
      source: PLUGIN_SOURCE,
      needsKey: (c) => !c.apiKey && !process.env.KILO_API_KEY,
    });

    vi.stubEnv('KILO_API_KEY', 'secret-kilo');
    vi.stubEnv('AI_API_KEY', '');
    const live = createProvider(cfg({ provider: 'kilo', apiKey: '' }), { logger });
    expect(live.name).toBe('kilo');

    vi.stubEnv('KILO_API_KEY', '');
    const mocked = createProvider(cfg({ provider: 'kilo', apiKey: '' }), { logger });
    expect(mocked.name).toBe(MOCK_PROVIDER);
  });

  it('treats a registered provider with a key as live even with empty apiKey', () => {
    registries.providers.register('nim', fakeProvider('nim'), {
      source: PLUGIN_SOURCE,
      needsKey: (c) => !c.apiKey && !process.env.NVIDIA_NIM_API_KEY,
    });
    vi.stubEnv('NVIDIA_NIM_API_KEY', 'nv-key');
    vi.stubEnv('AI_API_KEY', '');
    const p = createProvider(cfg({ provider: 'nim', apiKey: '' }), { logger });
    expect(p.name).toBe('nim');
  });
});
