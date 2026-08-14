/**
 * Configuration loader: YAML files + environment -> ResolvedConfig.
 *
 * Design rules:
 *  - Booting must never be blocked by a bad config file. Anything unreadable is
 *    logged and skipped; the runtime falls back to schema defaults.
 *  - Environment variables ALWAYS win over YAML (per-bot env wins over global env).
 *  - Secrets found in YAML are accepted but loudly warned about, and every
 *    resolved secret is registered with the logger so it can never be printed.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import type { EventBus } from '../core/event.js';
import { registerSecret, type Logger } from '../core/logger.js';
import {
  AIConfigSchema,
  BotConfigSchema,
  GlobalConfigSchema,
  LogLevelSchema,
  MemoryConfigSchema,
  MediaConfigSchema,
  MediaProviderConfigSchema,
  SessionConfigSchema,
  type AIConfig,
  type BotConfig,
  type GlobalConfig,
  type ResolvedBotConfig,
  type ResolvedConfig,
} from './schema.js';

const BOT_FILE_RE = /\.ya?ml$/i;
const LOCAL_BOT_FILE_RE = /\.local\.ya?ml$/i;

export interface ConfigLoaderOptions {
  /** Project root. `config/` and `.env` are resolved against it. */
  rootDir: string;
  logger: Logger;
  events?: EventBus;
}

interface RawBotFile {
  file: string;
  stem: string;
  data: Record<string, unknown>;
}

interface GlobalLoad {
  global: GlobalConfig;
  /** Set when global.yaml exists but is unusable (syntax or schema failure). */
  fatal?: string;
  fatalPath?: string;
}

interface BuildResult {
  config: ResolvedConfig;
  fatal?: string;
  fatalPath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pruneUndefined(input: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isRecord(input)) return out;
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Objects merge recursively; arrays and scalar values replace the base. */
export function deepMerge(base: unknown, override: unknown): unknown {
  if (!isRecord(base) || !isRecord(override)) return override === undefined ? base : override;
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    result[key] = isRecord(value) && isRecord(result[key]) ? deepMerge(result[key], value) : value;
  }
  return result;
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${where}: ${issue.message}`;
  });
}

/** MOHO_BOT_<ID>_ prefix, non-alphanumerics folded to underscore. */
export function botEnvPrefix(id: string): string {
  return `MOHO_BOT_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_`;
}

/** Reads one immutable environment snapshot, treating blank values as unset. */
function envValue(source: Readonly<Record<string, string | undefined>>, key: string): string | undefined {
  const raw = source[key];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Minimal KEY=VALUE .env parser - no dotenv dependency. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    let key = trimmed.slice(0, eq).trim();
    if (key.startsWith('export ')) key = key.slice('export '.length).trim();
    if (key.length === 0) continue;
    let value = trimmed.slice(eq + 1).trim();
    const quoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")));
    if (quoted) {
      value = value.slice(1, -1);
    } else {
      // Strip a trailing ` # comment` from unquoted values.
      const comment = value.search(/\s#/);
      if (comment >= 0) value = value.slice(0, comment).trimEnd();
    }
    out[key] = value;
  }
  return out;
}

export class ConfigLoader {
  readonly #rootDir: string;
  readonly #log: Logger;
  readonly #events: EventBus | undefined;
  #last: ResolvedConfig | undefined;
  #env: Readonly<Record<string, string | undefined>> = Object.freeze({ ...process.env });

  constructor(opts: ConfigLoaderOptions) {
    this.#rootDir = path.resolve(opts.rootDir);
    this.#log = opts.logger.child({ mod: 'config' });
    this.#events = opts.events;
  }

  get rootDir(): string {
    return this.#rootDir;
  }

  get configDir(): string {
    return path.join(this.#rootDir, 'config');
  }

  get globalFile(): string {
    return path.join(this.configDir, 'global.yaml');
  }

  get globalLocalFile(): string {
    return path.join(this.configDir, 'global.local.yaml');
  }

  get botsDir(): string {
    return path.join(this.configDir, 'bots');
  }

  /** Last successfully resolved config, if any. */
  current(): ResolvedConfig | undefined {
    return this.#last;
  }

  async load(): Promise<ResolvedConfig> {
    const built = await this.#build();
    if (built.fatal !== undefined) {
      this.#log.warn(
        { file: built.fatalPath, error: built.fatal },
        'global config unusable - falling back to defaults',
      );
    }
    this.#last = built.config;
    return built.config;
  }

  /**
   * Re-read everything. Never throws. On failure the previously good config is
   * returned unchanged and `config:reload:failed` is emitted.
   */
  async reload(): Promise<ResolvedConfig> {
    try {
      const built = await this.#build();
      if (built.fatal !== undefined && this.#last !== undefined) {
        this.#log.error(
          { file: built.fatalPath, error: built.fatal },
          'config reload rejected - keeping previous config',
        );
        this.#events?.emit('config:reload:failed', {
          path: built.fatalPath ?? this.configDir,
          error: built.fatal,
        });
        return this.#last;
      }
      if (built.fatal !== undefined) {
        this.#log.warn(
          { file: built.fatalPath, error: built.fatal },
          'global config unusable - falling back to defaults',
        );
      }
      this.#last = built.config;
      this.#log.info({ bots: built.config.bots.length }, 'config reloaded');
      this.#events?.emit('config:reload', { path: this.configDir });
      return built.config;
    } catch (error) {
      const message = errText(error);
      this.#log.error({ error: message }, 'config reload failed');
      this.#events?.emit('config:reload:failed', { path: this.configDir, error: message });
      return this.#last ?? (await this.#fallback());
    }
  }

  // ---------------------------------------------------------------- internals

  async #build(): Promise<BuildResult> {
    this.#env = await this.#loadEnvSnapshot();

    const loaded = await this.#loadGlobal();
    const global = loaded.global;

    const { found, entries } = await this.#readBotFiles();
    const bots: ResolvedBotConfig[] = [];
    const seen = new Set<string>();

    for (const entry of entries) {
      const data: Record<string, unknown> = { ...entry.data };
      const rawId = data['id'];
      if (typeof rawId !== 'string' || rawId.trim().length === 0) data['id'] = entry.stem;

      this.#warnYamlSecrets(entry.file, data);

      const parsed = BotConfigSchema.safeParse(data);
      if (!parsed.success) {
        this.#log.error(
          { file: entry.file, issues: formatIssues(parsed.error) },
          'invalid bot config - skipping this bot',
        );
        continue;
      }
      if (seen.has(parsed.data.id)) {
        this.#log.error({ file: entry.file, id: parsed.data.id }, 'duplicate bot id - skipping');
        continue;
      }
      seen.add(parsed.data.id);
      bots.push(await this.#resolveBot(parsed.data, global));
    }

    if (found === 0) {
      this.#log.warn({ dir: this.botsDir }, 'no bot config files found - synthesizing default bot "main"');
      bots.push(await this.#resolveBot(BotConfigSchema.parse({ id: 'main' }), global));
    } else if (bots.length === 0) {
      this.#log.error({ dir: this.botsDir, files: found }, 'every bot config failed validation - no bots loaded');
    }

    this.#registerSecrets(global, bots);

    return {
      config: { global, bots, rootDir: this.#rootDir },
      fatal: loaded.fatal,
      fatalPath: loaded.fatalPath,
    };
  }

  async #fallback(): Promise<ResolvedConfig> {
    const global = this.#applyGlobalEnv(GlobalConfigSchema.parse({}));
    return {
      global,
      bots: [await this.#resolveBot(BotConfigSchema.parse({ id: 'main' }), global)],
      rootDir: this.#rootDir,
    };
  }

  async #loadEnvSnapshot(): Promise<Readonly<Record<string, string | undefined>>> {
    const files: Record<string, string> = {};
    // Shared .env is the base; machine-local .env.local overrides it.
    for (const filename of ['.env', '.env.local']) {
      const envPath = path.join(this.#rootDir, filename);
      try {
        Object.assign(files, parseEnvFile(await readFile(envPath, 'utf8')));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') this.#log.warn({ file: envPath, error: errText(error) }, `unable to read ${filename}`);
      }
    }
    const snapshot = Object.freeze({ ...files, ...process.env });
    this.#log.debug({ fileKeys: Object.keys(files).length }, 'built isolated environment snapshot');
    return snapshot;
  }

  async #loadGlobal(): Promise<GlobalLoad> {
    const file = this.globalFile;
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        const local = await this.#readOptionalMapping(this.globalLocalFile, 'global local override');
        if (local) {
          this.#warnUnknownFields(this.globalLocalFile, local, GlobalConfigSchema);
          const parsed = GlobalConfigSchema.safeParse(local);
          if (parsed.success) return { global: this.#applyGlobalEnv(parsed.data) };
          this.#log.warn({ file: this.globalLocalFile, issues: formatIssues(parsed.error) }, 'invalid global local override - using schema defaults');
        }
        this.#log.warn({ file }, 'global.yaml not found - using schema defaults');
        return { global: this.#applyGlobalEnv(GlobalConfigSchema.parse({})) };
      }
      return {
        global: this.#applyGlobalEnv(GlobalConfigSchema.parse({})),
        fatal: errText(error),
        fatalPath: file,
      };
    }

    let data: unknown;
    try {
      data = parseYaml(text) ?? {};
    } catch (error) {
      return {
        global: this.#applyGlobalEnv(GlobalConfigSchema.parse({})),
        fatal: `invalid YAML: ${errText(error)}`,
        fatalPath: file,
      };
    }

    if (!isRecord(data)) {
      return {
        global: this.#applyGlobalEnv(GlobalConfigSchema.parse({})),
        fatal: 'global.yaml must contain a mapping',
        fatalPath: file,
      };
    }

    let mergedData: Record<string, unknown> = data;
    const local = await this.#readOptionalMapping(this.globalLocalFile, 'global local override');
    if (local) mergedData = deepMerge(mergedData, local) as Record<string, unknown>;

    // AstrBot-style provider overrides from data/provider.yaml.
    const providerOverrides = await this.#loadProviderOverrides();
    if (Object.keys(providerOverrides).length > 0) {
      mergedData.ai = deepMerge(providerOverrides, pruneUndefined(mergedData.ai));
    }

    this.#warnYamlSecrets(file, mergedData);
    this.#warnUnknownFields(file, mergedData, GlobalConfigSchema);

    const parsed = GlobalConfigSchema.safeParse(mergedData);
    if (!parsed.success) {
      return {
        global: this.#applyGlobalEnv(GlobalConfigSchema.parse({})),
        fatal: formatIssues(parsed.error).join('; '),
        fatalPath: file,
      };
    }
    return { global: this.#applyGlobalEnv(parsed.data) };
  }

  async #readBotFiles(): Promise<{ found: number; entries: RawBotFile[] }> {
    let names: string[];
    try {
      names = await readdir(this.botsDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        this.#log.warn({ dir: this.botsDir, error: errText(error) }, 'unable to read bots directory');
      }
      return { found: 0, entries: [] };
    }

    // A *.local.yaml file only overrides its tracked sibling; it is never a bot.
    const files = names.filter((name) => BOT_FILE_RE.test(name) && !LOCAL_BOT_FILE_RE.test(name)).sort();
    const entries: RawBotFile[] = [];

    for (const name of files) {
      const file = path.join(this.botsDir, name);
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch (error) {
        this.#log.error({ file, error: errText(error) }, 'unable to read bot config - skipping');
        continue;
      }
      let data: unknown;
      try {
        data = parseYaml(text) ?? {};
      } catch (error) {
        this.#log.error({ file, error: errText(error) }, 'invalid YAML in bot config - skipping');
        continue;
      }
      if (!isRecord(data)) {
        this.#log.error({ file }, 'bot config must contain a mapping - skipping');
        continue;
      }
      const stem = name.replace(BOT_FILE_RE, '');
      const localFile = path.join(this.botsDir, `${stem}.local.yaml`);
      const local = await this.#readOptionalMapping(localFile, 'bot local override');
      const merged = local ? deepMerge(data, local) as Record<string, unknown> : data;
      this.#warnUnknownFields(file, merged, BotConfigSchema);
      entries.push({ file, stem, data: merged });
    }

    return { found: files.length, entries };
  }

  async #resolveBot(bot: BotConfig, global: GlobalConfig): Promise<ResolvedBotConfig> {
    const prefix = botEnvPrefix(bot.id);

    const mergedAi = this.#parseOr(
      AIConfigSchema,
      { ...global.ai, ...pruneUndefined(bot.ai) },
      global.ai,
      `bot ${bot.id} ai`,
    );
    // Global env first, per-bot env last: the most specific source wins.
    const withEnv = this.#applyAiEnv(this.#applyAiEnv(mergedAi, ''), prefix);
    const ai = this.#parseOr(AIConfigSchema, withEnv, mergedAi, `bot ${bot.id} ai (env)`);

    const session = this.#parseOr(
      SessionConfigSchema,
      { ...global.session, ...pruneUndefined(bot.session) },
      global.session,
      `bot ${bot.id} session`,
    );

    const memory = this.#parseOr(
      MemoryConfigSchema,
      { ...global.memory, ...pruneUndefined(bot.memory) },
      global.memory,
      `bot ${bot.id} memory`,
    );

    const inheritedMedia = this.#parseOr(
      MediaConfigSchema,
      { ...global.media, ...pruneUndefined(bot.media), vision: { ...global.media.vision, ...pruneUndefined(bot.media.vision) }, ocr: { ...global.media.ocr, ...pruneUndefined(bot.media.ocr) } },
      global.media,
      `bot ${bot.id} media`,
    );
    const resolveMediaProvider = (provider: typeof inheritedMedia.vision, label: string) => {
      const apiKey = provider.enabled ? (envValue(this.#env, provider.apiKeyEnv!) ?? '') : '';
      if (provider.enabled && !apiKey) this.#log.warn({ bot: bot.id, provider: label, env: provider.apiKeyEnv }, 'media provider enabled but secret env is unset; provider disabled');
      return { ...MediaProviderConfigSchema.parse(provider), enabled: provider.enabled && apiKey.length > 0, apiKey };
    };
    const media = { ...inheritedMedia, vision: resolveMediaProvider(inheritedMedia.vision, 'vision'), ocr: resolveMediaProvider(inheritedMedia.ocr, 'ocr') };

    const discord = { ...bot.discord };
    const token = envValue(this.#env, `${prefix}DISCORD_TOKEN`) ?? envValue(this.#env, 'DISCORD_TOKEN');
    if (token !== undefined) discord.token = token;

    // `adapter` is an open registry name, so env can select any registered
    // gateway (e.g. MOHO_ADAPTER=telegram) without a schema change.
    let adapter = bot.adapter;
    const adapterEnv = envValue(this.#env, 'MOHO_ADAPTER');
    if (adapterEnv !== undefined) {
      const trimmed = adapterEnv.trim().toLowerCase();
      if (trimmed.length > 0) adapter = trimmed;
      else this.#log.warn({ MOHO_ADAPTER: adapterEnv }, 'ignoring empty MOHO_ADAPTER value');
    }

    // A bot may keep its system prompt in a file (systemPromptFile) instead of
    // inline YAML - better for large prompts and hot reload. If the file is
    // missing or unreadable we fall back to the inline/ default systemPrompt.
    let systemPrompt = bot.systemPrompt;
    if (bot.systemPromptFile) {
      try {
        const promptPath = path.isAbsolute(bot.systemPromptFile)
          ? bot.systemPromptFile
          : path.join(this.#rootDir, bot.systemPromptFile);
        systemPrompt = (await readFile(promptPath, 'utf8')).trimEnd();
        this.#log.debug({ file: bot.systemPromptFile }, 'loaded system prompt from file');
      } catch (error) {
        this.#log.warn(
          { file: bot.systemPromptFile, error: errText(error) },
          'systemPromptFile unreadable - using inline systemPrompt',
        );
      }
    }

    return { ...bot, adapter, discord, ai, session, memory, media, systemPrompt };
  }

  #applyGlobalEnv(global: GlobalConfig): GlobalConfig {
    const next: GlobalConfig = {
      ...global,
      storage: { ...global.storage },
      ai: { ...global.ai },
      session: { ...global.session },
      memory: { ...global.memory },
      media: { ...global.media, vision: { ...global.media.vision }, ocr: { ...global.media.ocr } },
    };

    const level = envValue(this.#env, 'LOG_LEVEL');
    if (level !== undefined) {
      const parsed = LogLevelSchema.safeParse(level.toLowerCase());
      if (parsed.success) next.logLevel = parsed.data;
      else this.#log.warn({ LOG_LEVEL: level }, 'ignoring invalid LOG_LEVEL value');
    }

    const storagePath = envValue(this.#env, 'MOHO_STORAGE_PATH');
    if (storagePath !== undefined) next.storage.path = storagePath;

    next.ai = this.#applyAiEnv(next.ai, '');
    return next;
  }

  #applyAiEnv(ai: AIConfig, prefix: string): AIConfig {
    const out: AIConfig = { ...ai };

    const apiKey = envValue(this.#env, `${prefix}AI_API_KEY`);
    if (apiKey !== undefined) out.apiKey = apiKey;

    const model = envValue(this.#env, `${prefix}AI_MODEL`);
    if (model !== undefined) out.model = model;

    const baseUrl = envValue(this.#env, `${prefix}AI_BASE_URL`);
    if (baseUrl !== undefined) {
      const parsed = AIConfigSchema.shape.baseUrl.safeParse(baseUrl);
      if (parsed.success) out.baseUrl = parsed.data;
      else this.#log.warn({ key: `${prefix}AI_BASE_URL`, value: baseUrl }, 'ignoring invalid base URL');
    }

    return out;
  }

  #parseOr<S extends z.ZodTypeAny>(schema: S, value: unknown, fallback: z.output<S>, label: string): z.output<S> {
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data as z.output<S>;
    this.#log.warn({ section: label, issues: formatIssues(parsed.error) }, 'invalid config section - using inherited values');
    return fallback;
  }

  #warnYamlSecrets(file: string, data: Record<string, unknown>): void {
    const ai = data['ai'];
    if (isRecord(ai)) {
      const apiKey = ai['apiKey'];
      if (typeof apiKey === 'string' && apiKey.trim().length > 0) {
        registerSecret(apiKey);
        this.#log.warn({ file, field: 'ai.apiKey' }, 'API key found in YAML - move it to the environment (AI_API_KEY)');
      }
    }
    const discord = data['discord'];
    if (isRecord(discord)) {
      const token = discord['token'];
      if (typeof token === 'string' && token.trim().length > 0) {
        registerSecret(token);
        this.#log.warn(
          { file, field: 'discord.token' },
          'Discord token found in YAML - move it to the environment (DISCORD_TOKEN)',
        );
      }
    }
  }

  #registerSecrets(global: GlobalConfig, bots: ResolvedBotConfig[]): void {
    if (global.ai.apiKey.length > 0) registerSecret(global.ai.apiKey);
    for (const bot of bots) {
      if (bot.ai.apiKey.length > 0) registerSecret(bot.ai.apiKey);
      if (bot.discord.token.length > 0) registerSecret(bot.discord.token);
      if (bot.media.vision.apiKey.length > 0) registerSecret(bot.media.vision.apiKey);
      if (bot.media.ocr.apiKey.length > 0) registerSecret(bot.media.ocr.apiKey);
    }
  }

  async #readOptionalMapping(file: string, label: string): Promise<Record<string, unknown> | undefined> {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      this.#log.warn({ file, error: errText(error) }, `unable to read ${label} - ignoring`);
      return undefined;
    }
    try {
      const data = parseYaml(text) ?? {};
      if (!isRecord(data)) {
        this.#log.warn({ file }, `${label} must contain a mapping - ignoring`);
        return undefined;
      }
      return data;
    } catch (error) {
      this.#log.warn({ file, error: errText(error) }, `invalid YAML in ${label} - ignoring`);
      return undefined;
    }
  }

  #warnUnknownFields(file: string, data: Record<string, unknown>, schema: z.AnyZodObject): void {
    const fields: string[] = [];
    const visit = (value: Record<string, unknown>, objectSchema: z.AnyZodObject, prefix = ''): void => {
      const shape = objectSchema.shape as Record<string, z.ZodTypeAny>;
      for (const [key, child] of Object.entries(value)) {
        const field = prefix ? `${prefix}.${key}` : key;
        const expected = shape[key];
        if (!expected) { fields.push(field); continue; }
        let unwrapped: z.ZodTypeAny = expected;
        while (unwrapped instanceof z.ZodOptional || unwrapped instanceof z.ZodDefault || unwrapped instanceof z.ZodNullable) {
          unwrapped = unwrapped._def.innerType as z.ZodTypeAny;
        }
        if (isRecord(child) && unwrapped instanceof z.ZodObject) visit(child, unwrapped, field);
      }
    };
    visit(data, schema);
    if (fields.length > 0) {
      this.#log.warn({ file, fields: fields.sort() }, 'unknown config fields retained for forward compatibility and ignored by this version');
    }
  }

  /**
   * Optional AstrBot-style provider config. provider.local.yaml recursively
   * overrides provider.yaml before global/bot/env precedence is applied.
   */
  async #loadProviderOverrides(): Promise<Record<string, unknown>> {
    const file = path.join(this.#rootDir, 'data', 'provider.yaml');
    const localFile = path.join(this.#rootDir, 'data', 'provider.local.yaml');
    const tracked = await this.#readOptionalMapping(file, 'provider.yaml');
    const local = await this.#readOptionalMapping(localFile, 'provider.local.yaml');
    const data = deepMerge(tracked ?? {}, local ?? {}) as Record<string, unknown>;
    const resolveEnv = (value: unknown): unknown => {
      if (typeof value === 'string') return value.replace(/\$\{([^}]+)\}/g, (_m, name: string) => this.#env[name] ?? '');
      if (Array.isArray(value)) return value.map(resolveEnv);
      if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveEnv(item)]));
      return value;
    };
    const resolved = resolveEnv(data) as Record<string, unknown>;
    if (Object.keys(resolved).length > 0) {
      this.#warnUnknownFields(local ? localFile : file, resolved, AIConfigSchema);
      this.#log.debug({ file, local: Boolean(local) }, 'loaded provider overrides');
    }
    return resolved;
  }
}
