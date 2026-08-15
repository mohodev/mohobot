/**
 * Gateway module public surface.
 *
 * Consumers import from here and never from discord.js.
 *
 * Built-in gateways register themselves. Adding Telegram/Slack/Matrix means
 * `registries.gateways.register('telegram', factory)` from a plugin - NOT
 * editing this file.
 */

export * from './types.js';
export * from './adapter.js';
export * from './client.js';
export * from './console.js';

import type { ResolvedBotConfig } from '../config/schema.js';
import type { EventBus } from '../core/event.js';
import type { Logger } from '../core/logger.js';
import { registries, type GatewayFactory } from '../core/registries.js';
import { DiscordGateway } from './client.js';
import { ConsoleGateway } from './console.js';
import type { Gateway } from './types.js';

export interface GatewayDeps {
  events: EventBus;
  logger: Logger;
  /** Project state root used by gateway projections such as Presence. */
  rootDir?: string;
}

export const DISCORD_GATEWAY = 'discord';
export const CONSOLE_GATEWAY = 'console';

const discordFactory: GatewayFactory = (cfg, deps) =>
  new DiscordGateway({ botId: cfg.id, config: cfg, events: deps.events, logger: deps.logger, rootDir: deps.rootDir });
const consoleFactory: GatewayFactory = (cfg, deps) =>
  new ConsoleGateway({ botId: cfg.id, config: cfg, events: deps.events, logger: deps.logger });

/** Register the built-ins. Idempotent. */
export function registerBuiltinGateways(): void {
  if (!registries.gateways.has(DISCORD_GATEWAY)) {
    registries.gateways.register(DISCORD_GATEWAY, discordFactory, {
      source: 'builtin',
      description: 'Discord gateway (discord.js v14)',
    });
  }
  if (!registries.gateways.has(CONSOLE_GATEWAY)) {
    registries.gateways.register(CONSOLE_GATEWAY, consoleFactory, {
      source: 'builtin',
      description: 'stdin/stdout gateway for headless testing',
    });
  }
}

registerBuiltinGateways();

/**
 * Resolve a gateway for a bot.
 *
 * Falls back to the console gateway when the adapter is 'console', when the
 * Discord adapter has no token, or when the requested adapter is unknown - a
 * misconfigured bot still boots instead of crashing the runtime.
 */
export function createGateway(cfg: ResolvedBotConfig, deps: GatewayDeps): Gateway {
  const requested = (cfg.adapter ?? DISCORD_GATEWAY).trim() || DISCORD_GATEWAY;

  if (requested === CONSOLE_GATEWAY) {
    return registries.gateways.require(CONSOLE_GATEWAY)(cfg, deps);
  }

  // Token check applies only to the built-in Discord gateway; third-party
  // gateways carry their own credentials in their own config block.
  if (requested === DISCORD_GATEWAY && (cfg.discord?.token ?? '').trim().length === 0) {
    deps.logger.warn({ botId: cfg.id }, 'no discord token configured - falling back to the console gateway');
    return registries.gateways.require(CONSOLE_GATEWAY)(cfg, deps);
  }

  const factory = registries.gateways.resolve(requested, CONSOLE_GATEWAY, deps.logger);
  return factory(cfg, deps);
}
