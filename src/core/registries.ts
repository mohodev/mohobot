/**
 * The four extension points of MohoBot.
 *
 * Everything the runtime chooses at boot goes through one of these registries.
 * Adding a capability = registering a factory (from a plugin, or from an
 * `extensions/` module). It NEVER requires editing runtime source.
 *
 *   providers  - AI backends           (openai-compatible, mock, ...)
 *   gateways   - chat platforms        (discord, console, ...)
 *   storages   - persistence drivers   (sqlite, memory, ...)
 *   memories   - long-term memory      (null, ...)
 */

import type { AIConfig, ResolvedBotConfig, StorageConfig } from '../config/schema.js';
import type { AIProvider } from '../ai/types.js';
import type { Gateway } from '../discord/types.js';
import type { MemoryAdapter, Storage } from '../storage/types.js';
import type { EventBus } from './event.js';
import type { Logger } from './logger.js';
import { Registry } from './registry.js';

export interface ProviderFactoryDeps {
  logger: Logger;
  events?: EventBus;
  botId?: string;
  fetchImpl?: typeof fetch;
}
export type ProviderFactory = (cfg: AIConfig, deps: ProviderFactoryDeps) => AIProvider;

export interface GatewayFactoryDeps {
  events: EventBus;
  logger: Logger;
  /** Project state root for gateway-owned projections. */
  rootDir?: string;
}
export type GatewayFactory = (cfg: ResolvedBotConfig, deps: GatewayFactoryDeps) => Gateway;

export interface StorageFactoryDeps {
  rootDir: string;
  logger: Logger;
}
export type StorageFactory = (cfg: StorageConfig, deps: StorageFactoryDeps) => Storage;

export interface MemoryFactoryDeps {
  botId: string;
  logger: Logger;
  /** The runtime's Storage, so a memory adapter can persist without its own DB. */
  storage?: Storage;
  /** Free-form options from config `memory.options`. */
  options: Record<string, unknown>;
}
export type MemoryFactory = (deps: MemoryFactoryDeps) => MemoryAdapter;

/** Bundle handed to every module that may need to look something up. */
export interface Registries {
  providers: Registry<ProviderFactory>;
  gateways: Registry<GatewayFactory>;
  storages: Registry<StorageFactory>;
  memories: Registry<MemoryFactory>;
}

export function createRegistries(): Registries {
  return {
    providers: new Registry<ProviderFactory>('AI provider'),
    gateways: new Registry<GatewayFactory>('gateway'),
    storages: new Registry<StorageFactory>('storage driver'),
    memories: new Registry<MemoryFactory>('memory adapter'),
  };
}

/**
 * Process-wide registries used by the running bot.
 *
 * Tests that need isolation should build their own with `createRegistries()`
 * rather than mutating this one.
 */
export const registries: Registries = createRegistries();
