/**
 * Configuration contract (zod).
 *
 * Rules:
 *  - Secrets never live in YAML. They come from env and are merged in by the loader.
 *  - Every field has a safe default so a bare config/global.yaml still boots.
 */

import { z } from 'zod';
import { RemoteStorageConfigSchema } from '../storage/remote-config.js';

export const LogLevelSchema = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

export const AIConfigSchema = z.object({
  /**
   * Registered provider name (see src/core/registries.ts). Open string, NOT an
   * enum: a plugin can register 'anthropic-native' and select it here without
   * any change to this schema.
   */
  provider: z.string().default('openai-compatible'),
  /** OpenAI-compatible base URL, e.g. https://api.deepseek.com/v1 */
  baseUrl: z.string().url().default('https://api.openai.com/v1'),
  /** Injected from env (AI_API_KEY / MOHO_BOT_<ID>_AI_API_KEY). Never from YAML. */
  apiKey: z.string().default(''),
  model: z.string().default('gpt-4o-mini'),
  temperature: z.number().min(0).max(2).default(0.8),
  timeoutMs: z.number().int().positive().default(60000),
  retries: z.number().int().min(0).max(10).default(2),
  retryBaseDelayMs: z.number().int().positive().default(500),
  stream: z.boolean().default(false),
  /** Message shown to users when the AI call ultimately fails. */
  fallbackReply: z.string().default('I could not reach my brain just now - try again in a moment.'),
  /** Free-form provider-specific options, passed through untouched. */
  options: z.record(z.unknown()).default({}),
});
export type AIConfig = z.infer<typeof AIConfigSchema>;

export const SessionConfigSchema = z.object({
  /** Max chat turns kept per session (system prompt excluded). */
  maxMessages: z.number().int().positive().default(20),
  /** Rough character budget for the assembled context. */
  maxChars: z.number().int().positive().default(8000),
  /** Session idle expiry. */
  ttlSeconds: z.number().int().positive().default(3600),
  /** channel = whole channel shares context; user = per user per channel. */
  scope: z.enum(['channel', 'user']).default('user'),
  /** Thread messages use their own context unless explicitly inherited from the parent channel. */
  threadContext: z.enum(['isolated', 'inherit-parent']).default('isolated'),
  /** Forum posts use their own context unless explicitly inherited from the forum channel. */
  forumContext: z.enum(['isolated', 'inherit-parent']).default('isolated'),
  /** Persist sessions to storage so restarts keep context. */
  persist: z.boolean().default(true),
});
export type SessionConfig = z.infer<typeof SessionConfigSchema>;

export const DiscordConfigSchema = z.object({
  /** Injected from env. Never from YAML. */
  token: z.string().default(''),
  /** Only respond when mentioned/replied-to (recommended for guilds). */
  respondToMentionsOnly: z.boolean().default(true),
  respondToDM: z.boolean().default(true),
  /** Empty = all guilds allowed. */
  allowedGuilds: z.array(z.string()).default([]),
  allowedChannels: z.array(z.string()).default([]),
  /** Users always ignored (in addition to all bots). */
  blockedUsers: z.array(z.string()).default([]),
  ignoreBots: z.boolean().default(true),
  /** Show the typing indicator while the AI is thinking. */
  typingIndicator: z.boolean().default(true),
  /** Remove stale text-command registrations and keep an explicit interaction base. */
  registerEmptySlash: z.boolean().default(true),
  /** Discord hard limit is 2000; we chunk beyond this. */
  maxReplyLength: z.number().int().positive().max(2000).default(1900),
  /** Optional private channel for redacted operational failure summaries. */
  logChannelId: z.string().min(1).optional(),
});
export type DiscordConfig = z.infer<typeof DiscordConfigSchema>;

/** Long-term memory selection. MVP default is the no-op 'null' adapter. */
export const MemoryConfigSchema = z.object({
  /** Registered memory adapter name (see src/core/registries.ts). */
  adapter: z.string().default('null'),
  enabled: z.boolean().default(true),
  /** Adapter-specific options (embedding model, top-k, collection, ...). */
  options: z.record(z.unknown()).default({}),
});
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;

export const MediaProviderConfigSchema = z.object({
  enabled: z.boolean().default(false),
  baseUrl: z.string().url().default('https://api.openai.com/v1'),
  model: z.string().min(1).default('gpt-4o-mini'),
  /** Name of the environment variable containing the secret. Never the secret itself. */
  apiKeyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).default('AI_API_KEY'),
  timeoutMs: z.number().int().positive().max(120000).default(30000),
});
export type MediaProviderConfig = z.infer<typeof MediaProviderConfigSchema>;

export const MediaConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Exact download hosts. Redirect targets are checked against the same list. */
  hostAllowlist: z.array(z.string().trim().min(1)).min(1).default(['cdn.discordapp.com', 'media.discordapp.net']),
  maxAttachments: z.number().int().positive().max(10).default(4),
  maxFileBytes: z.number().int().positive().default(10 * 1024 * 1024),
  maxTotalBytes: z.number().int().positive().default(20 * 1024 * 1024),
  concurrency: z.number().int().positive().max(8).default(2),
  cacheTtlMs: z.number().int().positive().default(24 * 60 * 60 * 1000),
  vision: MediaProviderConfigSchema.default({}),
  ocr: MediaProviderConfigSchema.default({}),
});
export type MediaConfig = z.infer<typeof MediaConfigSchema>;
export interface ResolvedMediaProviderConfig extends MediaProviderConfig { apiKey: string; }
export interface ResolvedMediaConfig extends Omit<MediaConfig, 'vision' | 'ocr'> {
  vision: ResolvedMediaProviderConfig;
  ocr: ResolvedMediaProviderConfig;
}
const MediaConfigOverrideSchema = MediaConfigSchema.partial().extend({
  vision: MediaProviderConfigSchema.partial().optional(),
  ocr: MediaProviderConfigSchema.partial().optional(),
});

export const ConfigVersionSchema = z.union([z.string().min(1), z.number().int().nonnegative()]).optional();

export const BotConfigSchema = z.object({
  /** Optional format marker for forward-compatible tooling; not required at runtime. */
  version: ConfigVersionSchema,
  id: z.string().min(1),
  name: z.string().default('MohoBot'),
  enabled: z.boolean().default(true),
  /**
   * Registered gateway name. Open string, NOT an enum: registering a
   * 'telegram' gateway from a plugin makes `adapter: telegram` valid here
   * without touching this schema.
   */
  adapter: z.string().default('discord'),
  systemPrompt: z.string().default('You are MohoBot, a helpful Discord assistant. Answer concisely.'),
  /**
   * Alternative to systemPrompt: load the system prompt from a file relative
   * to the project root (e.g. 'prompts/moho-system.md'). Enables large prompts
   * to live outside YAML and be hot-reloaded by editing the file. If both are
   * set, systemPromptFile wins.
   */
  systemPromptFile: z.string().optional(),
  discord: DiscordConfigSchema.default({}),
  ai: AIConfigSchema.partial().default({}),
  session: SessionConfigSchema.partial().default({}),
  memory: MemoryConfigSchema.partial().default({}),
  media: MediaConfigOverrideSchema.default({}),
  /** Plugin ids disabled for this bot only. */
  disabledPlugins: z.array(z.string()).default([]),
  /**
   * Marks this bot as the privileged administrator persona. `?` commands are
   * ignored by every other bot and by users outside the explicit allowlist.
   */
  admin: z.object({
    enabled: z.boolean().default(false),
    userIds: z.array(z.string()).default([]),
    /** Discord role names that authorize Bot management in a guild. */
    roleNames: z.array(z.string()).default(['Bot 管理']),
    /** Guilds where role-based Discord administration is accepted. */
    guildIds: z.array(z.string()).default([]),
  }).default({}),
  /** Optional public Discord presence projection of coarse character activity. */
  presence: z.object({
    enabled: z.boolean().default(false),
    updateIntervalSeconds: z.number().int().min(60).max(3600).default(300),
  }).default({}),
  /** Per-user rate limit. */
  rateLimit: z
    .object({
      enabled: z.boolean().default(true),
      windowMs: z.number().int().positive().default(10000),
      max: z.number().int().positive().default(3),
    })
    .default({}),
  /**
   * Config blocks for third-party gateways/providers, keyed by their
   * registered name. The runtime passes these through untouched.
   */
  extra: z.record(z.unknown()).default({}),
});
export type BotConfig = z.infer<typeof BotConfigSchema>;

export const StorageConfigSchema = z.object({
  /**
   * Registered driver name. Open string, NOT an enum, so a plugin can register
   * 'postgres' or 'redis' and select it here with no schema change.
   */
  driver: z.string().default('sqlite'),
  path: z.string().default('./data/mohobot.db'),
  /** Explicit disaster-mode opt-in. Production SQLite otherwise fails closed. */
  allowEphemeralFallback: z.boolean().default(false),
  /** Driver-specific options (connection string, pool size, ...). */
  options: z.record(z.unknown()).default({}),
});
export type StorageConfig = z.infer<typeof StorageConfigSchema>;

export const SupervisorConfigSchema = z.object({
  /** Restart a crashed component automatically. */
  autoRestart: z.boolean().default(true),
  maxRestarts: z.number().int().min(0).default(10),
  /** Restart counter resets after this quiet period. */
  restartWindowMs: z.number().int().positive().default(300000),
  backoffBaseMs: z.number().int().positive().default(1000),
  backoffMaxMs: z.number().int().positive().default(60000),
  /** Log-and-continue on unhandled rejections instead of exiting. */
  crashOnUnhandled: z.boolean().default(false),
  shutdownTimeoutMs: z.number().int().positive().default(10000),
});
export type SupervisorConfig = z.infer<typeof SupervisorConfigSchema>;

export const HotReloadConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Directories watched for changes, relative to the project root. */
  paths: z.array(z.string()).default(['config', 'plugins']),
  debounceMs: z.number().int().positive().default(300),
});
export type HotReloadConfig = z.infer<typeof HotReloadConfigSchema>;

export const GlobalConfigSchema = z.object({
  /** Optional format marker for forward-compatible tooling; not required at runtime. */
  version: ConfigVersionSchema,
  logLevel: LogLevelSchema.default('info'),
  admin: z.object({host:z.string().default('127.0.0.1'),port:z.number().int().min(1).max(65535).default(3210),token:z.string().default('')}).default({}),
  storage: StorageConfigSchema.default({}),
  remoteStorage: RemoteStorageConfigSchema.default({}),
  supervisor: SupervisorConfigSchema.default({}),
  hotReload: HotReloadConfigSchema.default({}),
  plugins: z
    .object({
      enabled: z.boolean().default(true),
      dir: z.string().default('./plugins'),
      /** Empty = load every plugin found. */
      allow: z.array(z.string()).default([]),
      deny: z.array(z.string()).default([]),
      /** A plugin exceeding this many ms on one hook is considered faulty. */
      hookTimeoutMs: z.number().int().positive().default(5000),
      /** Disable a plugin after this many consecutive errors. */
      maxErrors: z.number().int().positive().default(5),
    })
    .default({}),
  /** Defaults inherited by every bot; per-bot config wins. */
  ai: AIConfigSchema.default({}),
  session: SessionConfigSchema.default({}),
  memory: MemoryConfigSchema.default({}),
  media: MediaConfigSchema.default({}),
});
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

/** Fully-resolved runtime configuration handed to the Supervisor. */
export interface ResolvedConfig {
  global: GlobalConfig;
  bots: ResolvedBotConfig[];
  /** Absolute project root used to resolve relative paths. */
  rootDir: string;
}

/** A bot config with global defaults + env secrets already merged in. */
export interface ResolvedBotConfig extends Omit<BotConfig, 'ai' | 'session' | 'memory' | 'media'> {
  ai: AIConfig;
  session: SessionConfig;
  memory: MemoryConfig;
  media: ResolvedMediaConfig;
}
