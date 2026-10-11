/**
 * Configuration contract (zod).
 *
 * Rules:
 *  - Secrets never live in YAML. They come from env and are merged in by the loader.
 *  - Every field has a safe default so a bare data/config/global.yaml still boots.
 */

import { z } from 'zod';

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
  timeoutMs: z.number().int().positive().default(120000),
  retries: z.number().int().min(0).max(10).default(2),
  retryBaseDelayMs: z.number().int().positive().default(500),
  stream: z.boolean().default(false),
  /** Message shown to users when the AI call ultimately fails. */
  fallbackReply: z.string().default('（刚才没连上，想说的话再发一次吧）'),
  /** Free-form provider-specific options, passed through untouched. */
  options: z.record(z.unknown()).default({}),
});
export type AIConfig = z.infer<typeof AIConfigSchema>;

/**
 * LLM context summarization. When enabled and a summarizer is attached, the
 * oldest turns are folded into a rolling summary instead of being dropped by
 * the hard maxMessages/maxChars trim, which stays as the failure fallback.
 */
export const ContextSummaryConfigSchema = z.object({
  /** Master switch. Off (or no summarizer attached) = plain hard trimming. */
  enabled: z.boolean().default(true),
  /** Compact once the active turns reach this many rounds (2 messages = 1 round). */
  trimAtRounds: z.number().int().min(2).default(40),
  /** How many of the oldest rounds one compaction folds into the summary. */
  trimRemoveRounds: z.number().int().min(1).default(15),
  /** Also compact when active chars reach this fraction of session.maxChars. */
  triggerRatio: z.number().min(0.3).max(0.95).default(0.8),
  /** Never compact away the newest N messages. */
  minKeepMessages: z.number().int().min(2).default(4),
  /** Hard cap on stored summary length (chars). */
  maxSummaryChars: z.number().int().min(200).default(1500),
  /** Turns older than this are eligible for the periodic age sweep. */
  summaryAgeHours: z.number().min(1).default(3),
  /** Periodic age-based compaction of idle sessions. */
  sweepEnabled: z.boolean().default(true),
  /** A freshly summarized session is not age-compacted again within this window. */
  minIntervalHours: z.number().min(1).default(24),
});
export type ContextSummaryConfig = z.infer<typeof ContextSummaryConfigSchema>;

export const SessionConfigSchema = z.object({
  /** Rolling LLM summary of older turns (see ContextSummaryConfigSchema). */
  contextSummary: ContextSummaryConfigSchema.default({}),
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
  /** Bot authors exempted from ignoreBots - fellow RP characters allowed to banter. */
  peerBots: z.array(z.string()).default([]),
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
  // contextSummary stays truly partial here (no defaults) so a bot that tweaks
  // one knob does not silently reset the other knobs the global config set.
  session: SessionConfigSchema.extend({ contextSummary: ContextSummaryConfigSchema.partial() }).partial().default({}),
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
  /**
   * How the bot behaves in group conversations nobody addressed it in. By
   * default it listens: it answers mentions, replies, DMs, peer RP banter and
   * room questions, and stays quiet for everything else so it never feels like
   * a slot machine. Opting in restores occasional voluntary participation.
   */
  social: z
    .object({
      proactiveParticipation: z.boolean().default(false),
      /** Odds per observed message when proactiveParticipation is on. */
      proactiveChance: z.number().min(0).max(1).default(0.16),
    })
    .default({}),
  /**
   * Private single-turn persona A/B evaluation: a DM is occasionally answered
   * twice with the same input and parameters, swapping only the persona, and
   * the user votes anonymously. This is how a prompt beta is tested against
   * the shipped baseline. Disabled by default - an evaluation costs roughly
   * two extra model calls plus the card delivery.
   */
  personaAb: z
    .object({
      enabled: z.boolean().default(false),
      /** Prompt file for the control side; unset = the bot's live persona. */
      baselinePromptFile: z.string().min(1).optional(),
      /** Prompt file for the challenger side; unset = no evaluation can run. */
      testPromptFile: z.string().min(1).optional(),
      /** Sampling probability per DM once the slot and cooldown allow it. */
      probability: z.number().min(0).max(1).default(0.05),
      /** Quiet period per user after each evaluation. */
      cooldownSeconds: z.number().int().min(0).max(86400).default(900),
      /** How long a delivered card stays votable. */
      pendingSeconds: z.number().int().min(60).max(604800).default(86400),
    })
    .default({}),
  /** Per-user rate limit. */
  rateLimit: z
    .object({
      enabled: z.boolean().default(true),
      windowMs: z.number().int().positive().default(10000),
      max: z.number().int().positive().default(3),
    })
    .default({}),
  /**
   * Relationship tracking: favor/intimacy plus an eight-dimension mood, updated
   * after each reply by a second LLM pass (with keyword fallback when that
   * model is unavailable) and injected into the reply prompt as a tone guide.
   * Disabled by default - it adds one small analysis call per analysed turn.
   */
  emotion: z
    .object({
      enabled: z.boolean().default(false),
      /** Turns skipped between analyses when nothing forces one. */
      analysisRoundCooldown: z.number().int().min(0).max(20).default(2),
      /** Wall-clock floor between two analyses for one user. */
      minIntervalMs: z.number().int().min(0).max(3600_000).default(60000),
      /** Hard cap: analyse at least every N analysed turns. */
      forceUpdateInterval: z.number().int().min(1).max(100).default(8),
      /** Emotional keyword weight needed to justify an analysis. */
      keywordThreshold: z.number().int().min(1).max(20).default(3),
      /** Significance needed to write a long-term interaction record. */
      significanceThreshold: z.number().int().min(1).max(10).default(3),
      /** Skip the analysis entirely when nothing emotional happened. */
      smartUpdate: z.boolean().default(true),
      analysisTimeoutMs: z.number().int().min(1000).max(300_000).default(90000),
      /** Concurrent analysis calls; the rest queue. */
      maxConcurrent: z.number().int().min(1).max(8).default(2),
      favorMin: z.number().int().min(-100).max(0).default(-100),
      favorMax: z.number().int().min(0).max(100).default(100),
      intimacyMin: z.number().int().min(0).max(100).default(0),
      intimacyMax: z.number().int().min(1).max(200).default(100),
    })
    .default({}),
  /**
   * Song knowledge: recognizes song titles and lyric fragments in chat and
   * injects a 【歌曲信息】 block (intro + credits + full lyrics) for the
   * model, request-scoped only. Library syncs from VCPedia; see
   * scripts/sync-songs.ts and the `?同步歌曲` admin command.
   */
  songs: z
    .object({
      enabled: z.boolean().default(false),
      /** Minimum bare song-name length for context-word matching. */
      minNameLength: z.number().int().min(2).max(10).default(3),
    })
    .default({}),
  /**
   * Silently ignore auto-replies and a sender repeating the same text
   * `maxRepeats` times within `windowMs` (spam, stuck clients, bot echo loops).
   */
  repeatGuard: z
    .object({
      enabled: z.boolean().default(true),
      maxRepeats: z.number().int().min(2).max(50).default(3),
      windowMs: z.number().int().min(1000).default(300_000),
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
   * e.g. 'postgres' and select it here with no schema change. SQLite is the
   * only built-in driver; anything unregistered degrades to SQLite with a
   * warning instead of silently losing data.
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
  paths: z.array(z.string()).default(['data/config', 'plugins']),
  debounceMs: z.number().int().positive().default(300),
});
export type HotReloadConfig = z.infer<typeof HotReloadConfigSchema>;

export const GlobalConfigSchema = z.object({
  /** Optional format marker for forward-compatible tooling; not required at runtime. */
  version: ConfigVersionSchema,
  logLevel: LogLevelSchema.default('info'),
  admin: z.object({host:z.string().default('127.0.0.1'),port:z.number().int().min(1).max(65535).default(3210),token:z.string().default('')}).default({}),
  storage: StorageConfigSchema.default({}),
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
