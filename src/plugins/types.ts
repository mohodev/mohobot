/**
 * Plugin contract.
 *
 * Plugins are loaded from ./plugins/<id>/index.ts and may NEVER take the
 * runtime down: every hook call is timeout-guarded and error-isolated by the
 * PluginManager, which disables a repeatedly failing plugin.
 */

import type { EventBus } from '../core/event.js';
import type { Logger } from '../core/logger.js';
import type { Registries } from '../core/registries.js';
import type { MohoMessage, OutboundMessage } from '../core/types.js';
import type { ResolvedBotConfig } from '../config/schema.js';
import type { ScopedStorage } from '../storage/types.js';

export interface PluginManifest {
  /** Unique id; must match the directory name. */
  name: string;
  version: string;
  description?: string;
  author?: string;
  /** Entry file relative to the plugin dir. Default: index.ts */
  main?: string;
  enabled?: boolean;
  /** Lower runs first. Default 100. */
  priority?: number;
  /** Arbitrary plugin settings, surfaced as `ctx.config`. */
  config?: Record<string, unknown>;
}

export interface PluginCommand {
  name: string;
  description?: string;
  /** Return a string to reply, or void to stay silent. */
  execute(ctx: CommandContext): Promise<string | void> | string | void;
}

export interface CommandContext {
  message: MohoMessage;
  args: string[];
  raw: string;
  reply(content: string): Promise<void>;
}

/** Everything a plugin is allowed to touch. No raw discord.js, no raw DB. */
export interface PluginContext {
  readonly pluginId: string;
  readonly logger: Logger;
  readonly events: EventBus;
  /** Storage namespaced to this plugin. */
  readonly storage: ScopedStorage;
  /** Send a message through the owning bot's gateway. */
  send(out: OutboundMessage): Promise<void>;
  /** Register a text command (prefix handled by the pipeline). */
  registerCommand(command: PluginCommand): void;
  /** Read-only view of plugin config from plugin.json "config" key. */
  readonly config: Record<string, unknown>;
  /** Resolved config of the bot this plugin is running under (secrets stripped). */
  readonly botConfig: ResolvedBotConfig;
  /**
   * The runtime extension points.
   *
   * This is how a plugin adds a new AI provider, chat gateway, storage driver
   * or memory adapter WITHOUT any change to src/. Entries registered here are
   * automatically unregistered when the plugin unloads.
   *
   *   ctx.registry.providers.register('anthropic', factory);
   *   ctx.registry.gateways.register('telegram', factory);
   *   ctx.registry.memories.register('vector', factory);
   */
  readonly registry: Registries;
}

/**
 * Result of onMessage. Returning nothing means "no opinion".
 *  - stop: true      -> pipeline halts, AI is not called
 *  - content         -> replaces the message content for downstream stages
 *  - reply           -> send this text back immediately
 */
export interface MessageHookResult {
  stop?: boolean;
  content?: string;
  reply?: string;
}

export interface Plugin {
  readonly name: string;
  onLoad?(ctx: PluginContext): void | Promise<void>;
  onUnload?(): void | Promise<void>;
  onMessage?(message: MohoMessage, ctx: PluginContext): MessageHookResult | void | Promise<MessageHookResult | void>;
  /** Called just before the AI request; may mutate the prompt array in place. */
  onBeforeAI?(input: { message: MohoMessage; messages: { role: string; content: string }[] }, ctx: PluginContext):
    | void
    | Promise<void>;
  /** Called with the AI reply; return a string to rewrite it. */
  onAfterAI?(input: { message: MohoMessage; reply: string }, ctx: PluginContext):
    | string
    | void
    | Promise<string | void>;
}

export type PluginState = 'loaded' | 'disabled' | 'failed' | 'unloaded';

export interface PluginRecord {
  id: string;
  manifest: PluginManifest;
  state: PluginState;
  dir: string;
  errors: number;
  lastError?: string;
  loadedAt?: number;
}

/** A plugin module must default-export a Plugin or a factory returning one. */
export type PluginModule =
  | { default: Plugin }
  | { default: () => Plugin | Promise<Plugin> }
  | { plugin: Plugin };
