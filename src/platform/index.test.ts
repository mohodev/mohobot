import { describe, expect, it } from 'vitest';
import { BotConfigSchema, type ResolvedBotConfig } from '../config/schema.js';
import { createRegistries } from '../core/registries.js';
import { EventBus } from '../core/event.js';
import { createNullLogger } from '../core/logger.js';
import { createGateway } from './index.js';
import type { Gateway } from './types.js';
import type { Gateway as LegacyGateway } from '../discord/types.js';

function botConfig(adapter: string): ResolvedBotConfig {
  return BotConfigSchema.parse({ id: 'platform-test', adapter }) as unknown as ResolvedBotConfig;
}

describe('platform gateway composition root', () => {
  it('resolves extension-provided platform IDs from the Runtime registry', () => {
    const runtimeRegistries = createRegistries();
    const matrixGateway: Gateway = {
      name: 'gateway:matrix:platform-test',
      botId: 'platform-test',
      platform: 'matrix',
      async start() {},
      async stop() {},
      async send() { return { status: 'delivered' }; },
      async typing() {},
      status() { return { connected: true, ping: 4, reconnects: 0 }; },
    };
    runtimeRegistries.gateways.register('matrix', () => matrixGateway, {
      source: 'test',
      description: 'fake Matrix adapter for contract test',
    });

    const result = createGateway(botConfig('matrix'), {
      events: new EventBus(),
      logger: createNullLogger(),
      registries: runtimeRegistries,
    });

    const legacyPathContract: LegacyGateway = matrixGateway;
    expect(result).toBe(matrixGateway);
    expect(legacyPathContract).toBe(matrixGateway);
    expect(result.platform).toBe('matrix');
    expect(runtimeRegistries.gateways.names()).toEqual(['console', 'discord', 'matrix']);
  });

  it('keeps the console fallback in isolated Runtime registries', () => {
    const runtimeRegistries = createRegistries();
    const result = createGateway(botConfig('unknown-platform'), {
      events: new EventBus(),
      logger: createNullLogger(),
      registries: runtimeRegistries,
    });

    expect(result.platform).toBe('console');
    expect(runtimeRegistries.gateways.names()).toEqual(['console', 'discord']);
  });

});
