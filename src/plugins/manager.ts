/**
 * PluginManager - loads, isolates, and hot-swaps plugins.
 *
 * Isolation contract:
 *  - every hook call is wrapped in try/catch AND a timeout
 *  - a plugin that exceeds `maxErrors` consecutive failures is disabled, not fatal
 *  - a load failure leaves the previously loaded version untouched
 *  - unloading always runs onUnload defensively and always frees the record
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { EventBus } from '../core/event.js';
import type { Logger } from '../core/logger.js';
import type { Registries } from '../core/registries.js';
import type { Registry, RegisterOptions } from '../core/registry.js';
import type { EmbedCard, MohoMessage, OutboundMessage } from '../core/types.js';
import type { SessionManagerLike } from '../session/types.js';
import type { ResolvedBotConfig } from '../config/schema.js';
import type { ScopedStorage } from '../storage/types.js';
import type {
  CommandContext,
  MessageHookResult,
  Plugin,
  PluginCommand,
  PluginContext,
  PluginManifest,
  PluginRecord,
} from './types.js';

export interface PluginManagerOptions {
  dir: string;
  logger: Logger;
  events: EventBus;
  hookTimeoutMs: number;
  maxErrors: number;
  allow: string[];
  deny: string[];
  /** Namespaced storage factory; undefined disables plugin storage. */
  storageFor?: (pluginId: string) => ScopedStorage;
  /** Outbound sender injected by the bot runtime. */
  send: (out: OutboundMessage) => Promise<void>;
  /** Resolved bot config exposed to plugins as `ctx.botConfig`. */
  botConfig: ResolvedBotConfig;
  /** Extension registries plugins may add to; entries are reaped on unload. */
  registries: Registries;
  /**
   * Optional re-feed into the live pipeline. When supplied, plugins can push a
   * synthetic message through the real pipeline (persona + session + commands).
   * Devtools `!act` uses this to inject messages as if from a real user.
   */
  pipelineHandle?: (message: MohoMessage) => Promise<void>;
  /** Optional session store, exposed read-only so plugins can inspect context (e.g. !记忆). */
  sessions?: SessionManagerLike;
}

interface LoadedPlugin {
  record: PluginRecord;
  plugin: Plugin;
  context: PluginContext;
  commands: Map<string, PluginCommand>;
}

const noopStorage: ScopedStorage = {
  async save() {},
  async get() {
    return undefined;
  },
  async delete() {},
  async query() {
    return [];
  },
};

export class PluginManager {
  readonly #plugins = new Map<string, LoadedPlugin>();
  readonly #opts: PluginManagerOptions;
  readonly #logger: Logger;

  constructor(options: PluginManagerOptions) {
    this.#opts = options;
    this.#logger = options.logger.child({ component: 'plugins' });
  }

  /** Load every plugin directory found under `dir`. Never throws. */
  async loadAll(): Promise<void> {
    let entries: string[];
    try {
      const dirents = await fs.readdir(this.#opts.dir, { withFileTypes: true });
      entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        this.#logger.info({ dir: this.#opts.dir }, 'no plugins directory; skipping');
      } else {
        this.#logger.error({ err: String(error) }, 'failed to scan plugins directory');
      }
      return;
    }

    for (const id of entries.sort()) {
      await this.load(id);
    }

    const loaded = [...this.#plugins.values()].filter((p) => p.record.state === 'loaded');
    this.#logger.info({ count: loaded.length, total: entries.length }, 'plugins loaded');
  }

  /**
   * Load (or reload) a single plugin by directory name.
   * On failure the previously loaded instance stays active.
   */
  async load(id: string): Promise<boolean> {
    if (this.#opts.deny.includes(id)) {
      this.#logger.info({ plugin: id }, 'plugin denied by config');
      return false;
    }
    if (this.#opts.allow.length > 0 && !this.#opts.allow.includes(id)) {
      this.#logger.debug({ plugin: id }, 'plugin not in allow list');
      return false;
    }

    const dir = path.join(this.#opts.dir, id);
    const previous = this.#plugins.get(id);

    let manifest: PluginManifest;
    try {
      manifest = await this.#readManifest(dir, id);
    } catch (error) {
      this.#fail(id, dir, error, 'manifest');
      return false;
    }

    if (manifest.enabled === false) {
      this.#logger.info({ plugin: id }, 'plugin disabled by manifest');
      if (previous) await this.unload(id);
      return false;
    }

    const entryFile = path.join(dir, manifest.main ?? 'index.ts');
    try {
      await fs.access(entryFile);
    } catch {
      this.#fail(id, dir, new Error(`entry file not found: ${entryFile}`), 'entry');
      return false;
    }

    // Stage the new instance BEFORE tearing down the old one.
    let staged: Plugin;
    try {
      // Cache-busting query so hot reload actually re-evaluates the module.
      const url = `${pathToFileURL(entryFile).href}?v=${Date.now()}`;
      const mod = (await import(url)) as Record<string, unknown>;
      staged = await this.#instantiate(mod, id);
    } catch (error) {
      this.#fail(id, dir, error, 'import');
      this.#logger.warn({ plugin: id }, previous ? 'keeping previously loaded version' : 'plugin not loaded');
      return false;
    }

    const commands = new Map<string, PluginCommand>();
    const context = this.#makeContext(id, commands, manifest);

    try {
      await this.#withTimeout(
        Promise.resolve(staged.onLoad?.(context)),
        this.#opts.hookTimeoutMs,
        `${id}.onLoad`,
      );
    } catch (error) {
      this.#fail(id, dir, error, 'onLoad');
      this.#logger.warn({ plugin: id }, previous ? 'keeping previously loaded version' : 'plugin not loaded');
      return false;
    }

    // New instance is healthy: retire the old one now.
    if (previous) await this.#teardown(previous);

    this.#plugins.set(id, {
      record: {
        id,
        manifest,
        state: 'loaded',
        dir,
        errors: 0,
        loadedAt: Date.now(),
      },
      plugin: staged,
      context,
      commands,
    });

    this.#logger.info({ plugin: id, version: manifest.version, commands: commands.size }, 'plugin loaded');
    this.#opts.events.emit('plugin:loaded', { pluginId: id });
    return true;
  }

  async unload(id: string): Promise<void> {
    const entry = this.#plugins.get(id);
    if (!entry) return;
    await this.#teardown(entry);
    this.#plugins.delete(id);
    this.#logger.info({ plugin: id }, 'plugin unloaded');
    this.#opts.events.emit('plugin:unloaded', { pluginId: id });
  }

  async unloadAll(): Promise<void> {
    for (const id of [...this.#plugins.keys()]) {
      await this.unload(id);
    }
  }

  /** Disable a misbehaving plugin without removing it from the registry. */
  disable(id: string, reason: string): void {
    const entry = this.#plugins.get(id);
    if (!entry) return;
    entry.record.state = 'disabled';
    entry.record.lastError = reason;
    this.#logger.error({ plugin: id, reason }, 'plugin disabled');
    this.#opts.events.emit('plugin:error', { pluginId: id, error: reason, phase: 'disabled' });
  }

  list(): PluginRecord[] {
    return [...this.#plugins.values()].map((p) => ({ ...p.record }));
  }

  /** All commands registered by active plugins, keyed by command name. */
  commands(): Map<string, { pluginId: string; command: PluginCommand }> {
    const out = new Map<string, { pluginId: string; command: PluginCommand }>();
    for (const entry of this.#active()) {
      for (const [name, command] of entry.commands) {
        if (!out.has(name)) out.set(name, { pluginId: entry.record.id, command });
      }
    }
    return out;
  }

  /**
   * Run onMessage across active plugins in priority order.
   * Returns the accumulated result; a plugin returning `stop` short-circuits.
   */
  async runMessageHooks(message: MohoMessage, skip: string[] = []): Promise<MessageHookResult> {
    const acc: MessageHookResult = {};
    let current = message;
    for (const entry of this.#active(skip)) {
      if (!entry.plugin.onMessage) continue;
      const result = await this.#callHook(entry, 'onMessage', () =>
        Promise.resolve(entry.plugin.onMessage!(current, entry.context)),
      );
      if (!result) continue;
      if (result.content !== undefined) {
        current = { ...current, content: result.content };
        acc.content = result.content;
      }
      if (result.reply !== undefined) acc.reply = result.reply;
      if (result.stop) {
        acc.stop = true;
        break;
      }
    }
    return acc;
  }

  async runBeforeAI(
    message: MohoMessage,
    messages: { role: string; content: string }[],
    skip: string[] = [],
  ): Promise<void> {
    for (const entry of this.#active(skip)) {
      if (!entry.plugin.onBeforeAI) continue;
      await this.#callHook(entry, 'onBeforeAI', () =>
        Promise.resolve(entry.plugin.onBeforeAI!({ message, messages }, entry.context)),
      );
    }
  }

  async runAfterAI(message: MohoMessage, reply: string, skip: string[] = []): Promise<string> {
    let current = reply;
    for (const entry of this.#active(skip)) {
      if (!entry.plugin.onAfterAI) continue;
      const result = await this.#callHook(entry, 'onAfterAI', () =>
        Promise.resolve(entry.plugin.onAfterAI!({ message, reply: current }, entry.context)),
      );
      if (typeof result === 'string' && result.length > 0) current = result;
    }
    return current;
  }

  async executeCommand(name: string, ctx: CommandContext, skip: string[] = []): Promise<string | EmbedCard | void> {
    for (const entry of this.#active(skip)) {
      const command = entry.commands.get(name);
      if (!command) continue;
      return this.#callHook(entry, `command:${name}`, () => Promise.resolve(command.execute(ctx)));
    }
    return undefined;
  }

  #active(skip: string[] = []): LoadedPlugin[] {
    return [...this.#plugins.values()]
      .filter((p) => p.record.state === 'loaded' && !skip.includes(p.record.id))
      .sort((a, b) => (a.record.manifest.priority ?? 100) - (b.record.manifest.priority ?? 100));
  }

  /** The single choke point where plugin failures are contained. */
  async #callHook<T>(entry: LoadedPlugin, phase: string, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      const result = await this.#withTimeout(fn(), this.#opts.hookTimeoutMs, `${entry.record.id}.${phase}`);
      entry.record.errors = 0; // consecutive-error counter
      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      entry.record.errors += 1;
      entry.record.lastError = msg;
      this.#logger.error(
        { plugin: entry.record.id, phase, err: msg, errors: entry.record.errors },
        'plugin hook failed (isolated)',
      );
      this.#opts.events.emit('plugin:error', { pluginId: entry.record.id, error: msg, phase });
      if (entry.record.errors >= this.#opts.maxErrors) {
        this.disable(entry.record.id, `exceeded ${this.#opts.maxErrors} consecutive errors`);
      }
      return undefined;
    }
  }

  async #teardown(entry: LoadedPlugin): Promise<void> {
    try {
      await this.#withTimeout(
        Promise.resolve(entry.plugin.onUnload?.()),
        this.#opts.hookTimeoutMs,
        `${entry.record.id}.onUnload`,
      );
    } catch (error) {
      this.#logger.warn(
        { plugin: entry.record.id, err: error instanceof Error ? error.message : String(error) },
        'onUnload failed (ignored)',
      );
    }
    entry.commands.clear();

    // Reap anything this plugin registered, otherwise a hot reload would hit
    // "already registered" on the next load and leak dead factories.
    const source = `plugin:${entry.record.id}`;
    const reaped: string[] = [];
    for (const registry of Object.values(this.#opts.registries)) {
      reaped.push(...registry.unregisterSource(source));
    }
    if (reaped.length > 0) {
      this.#logger.debug({ plugin: entry.record.id, reaped }, 'unregistered plugin extensions');
    }

    entry.record.state = 'unloaded';
  }

  #makeContext(id: string, commands: Map<string, PluginCommand>, manifest: PluginManifest): PluginContext {
    return {
      pluginId: id,
      logger: this.#logger.child({ plugin: id }),
      events: this.#opts.events,
      storage: this.#opts.storageFor?.(id) ?? noopStorage,
      send: async (out) => {
        await this.#opts.send(out);
      },
      registerCommand: (command) => {
        if (!command?.name) return;
        commands.set(command.name.toLowerCase(), command);
      },
      // Real settings from plugin.json "config", frozen so a plugin cannot
      // mutate what the next reload will read.
      config: Object.freeze({ ...(manifest.config ?? {}) }),
      botConfig: this.#opts.botConfig,
      // Registry proxy that stamps every entry with this plugin's id as the
      // source, so #teardown can reap them precisely on unload/reload.
      registry: this.#scopedRegistries(id),
      pipeline: this.#opts.pipelineHandle
        ? { handle: (message) => this.#opts.pipelineHandle!(message) }
        : undefined,
      sessions: this.#opts.sessions,
    };
  }

  /** Registries whose `register` calls are auto-tagged with the plugin id. */
  #scopedRegistries(id: string): Registries {
    const source = `plugin:${id}`;
    const wrap = <T>(registry: Registry<T>): Registry<T> =>
      new Proxy(registry, {
        get(target, prop, receiver) {
          if (prop === 'register') {
            return (name: string, factory: T, options: RegisterOptions = {}) =>
              target.register(name, factory, { ...options, source });
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

    return {
      providers: wrap(this.#opts.registries.providers),
      gateways: wrap(this.#opts.registries.gateways),
      storages: wrap(this.#opts.registries.storages),
      memories: wrap(this.#opts.registries.memories),
    };
  }

  async #readManifest(dir: string, id: string): Promise<PluginManifest> {
    const manifestPath = path.join(dir, 'plugin.json');
    let raw: string;
    try {
      raw = await fs.readFile(manifestPath, 'utf8');
    } catch {
      // Manifest is optional; synthesize a minimal one.
      return { name: id, version: '0.0.0', main: 'index.ts' };
    }
    const parsed = JSON.parse(raw) as Partial<PluginManifest> & Record<string, unknown>;
    if (parsed.name && parsed.name !== id) {
      this.#logger.warn({ plugin: id, declared: parsed.name }, 'manifest name differs from directory; using directory');
    }
    return {
      name: id,
      version: typeof parsed.version === 'string' ? parsed.version : '0.0.0',
      description: typeof parsed.description === 'string' ? parsed.description : undefined,
      author: typeof parsed.author === 'string' ? parsed.author : undefined,
      main: typeof parsed.main === 'string' ? parsed.main : 'index.ts',
      enabled: parsed.enabled !== false,
      priority: typeof parsed.priority === 'number' ? parsed.priority : 100,
    };
  }

  async #instantiate(mod: Record<string, unknown>, id: string): Promise<Plugin> {
    const candidate = (mod.default ?? mod.plugin) as unknown;
    if (typeof candidate === 'function') {
      const built = await (candidate as () => Plugin | Promise<Plugin>)();
      if (!built || typeof built !== 'object') throw new Error(`plugin "${id}" factory returned no object`);
      return built;
    }
    if (candidate && typeof candidate === 'object') return candidate as Plugin;
    throw new Error(`plugin "${id}" has no default export (expected Plugin or factory)`);
  }

  #fail(id: string, dir: string, error: unknown, phase: string): void {
    const msg = error instanceof Error ? error.message : String(error);
    const existing = this.#plugins.get(id);
    if (existing) {
      existing.record.lastError = msg;
      existing.record.errors += 1;
    }
    this.#logger.error({ plugin: id, dir, phase, err: msg }, 'plugin load failed');
    this.#opts.events.emit('plugin:error', { pluginId: id, error: msg, phase });
  }

  async #withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
