/**
 * Backward-compatible import surface for the original Discord gateway module.
 * New runtime code should import gateway contracts/factory from src/platform/.
 */

export * from './types.js';
export * from './adapter.js';
export * from './client.js';
export * from './console.js';
export {
  CONSOLE_GATEWAY,
  DISCORD_GATEWAY,
  createGateway,
  registerBuiltinGateways,
  type GatewayDeps,
} from '../platform/index.js';
