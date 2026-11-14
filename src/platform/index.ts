/**
 * Gateway composition root.
 *
 * Runtime code imports this module instead of src/discord. Built-in adapters
 * are wired here; third-party adapters register into the same gateway registry.
 * Concrete Discord/Console implementations remain isolated in src/discord/.
 */

export * from './types.js';
export * from './guild.js';

import type { ResolvedBotConfig } from '../config/schema.js';
import type { EventBus } from '../core/event.js';
import type { Logger } from '../core/logger.js';
import { registries, type GatewayFactory, type Registries } from '../core/registries.js';
import type { Registry } from '../core/registry.js';
import { DiscordGateway } from '../discord/client.js';
import { ConsoleGateway } from '../discord/console.js';
import type { Gateway } from './types.js';

export interface GatewayDeps {
  events: EventBus;
  logger: Logger;
  /** Project state root used by adapter-owned projections. */
  rootDir?: string;
  /** Runtime-scoped registry; defaults to the process-wide registry. */
  registries?: Pick<Registries, 'gateways'>;
}

export const DISCORD_GATEWAY = 'discord';
export const CONSOLE_GATEWAY = 'console';

const discordFactory: GatewayFactory = (cfg, deps) =>
  new DiscordGateway({ botId: cfg.id, config: cfg, events: deps.events, logger: deps.logger, rootDir: deps.rootDir });
const consoleFactory: GatewayFactory = (cfg, deps) =>
  new ConsoleGateway({ botId: cfg.id, config: cfg, events: deps.events, logger: deps.logger });

/** Register the built-ins. Idempotent. */
export function registerBuiltinGateways(gatewayRegistry: Registry<GatewayFactory> = registries.gateways): void {
  if (!gatewayRegistry.has(DISCORD_GATEWAY)) {
    gatewayRegistry.register(DISCORD_GATEWAY, discordFactory, {
      source: 'builtin',
      description: 'Discord gateway (discord.js v14)',
    });
  }
  if (!gatewayRegistry.has(CONSOLE_GATEWAY)) {
    gatewayRegistry.register(CONSOLE_GATEWAY, consoleFactory, {
      source: 'builtin',
      description: 'stdin/stdout gateway for headless testing',
    });
  }
}

registerBuiltinGateways();

/**
 * Resolve the configured platform adapter.
 *
 * Unknown adapters degrade to Console so a typo cannot crash all BotRuntime
 * instances. Third-party gateway adapters carry their own configuration and
 * credentials; only the built-in Discord gateway requires discord.token.
 */
export function createGateway(cfg: ResolvedBotConfig, deps: GatewayDeps): Gateway {
  const gatewayRegistry = deps.registries?.gateways ?? registries.gateways;
  registerBuiltinGateways(gatewayRegistry);
  const requested = (cfg.adapter ?? DISCORD_GATEWAY).trim() || DISCORD_GATEWAY;

  if (requested === CONSOLE_GATEWAY) {
    return gatewayRegistry.require(CONSOLE_GATEWAY)(cfg, deps);
  }

  if (requested === DISCORD_GATEWAY && (cfg.discord?.token ?? '').trim().length === 0) {
    deps.logger.warn({ botId: cfg.id }, 'no discord token configured - falling back to the console gateway');
    return registries.gateways.require(CONSOLE_GATEWAY)(cfg, deps);
  }

  const factory = gatewayRegistry.resolve(requested, CONSOLE_GATEWAY, deps.logger);
  return factory(cfg, deps);
}
