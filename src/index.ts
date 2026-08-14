/**
 * MohoBot entry point.
 *
 * Responsibilities:
 *  1. resolve config (yaml + env)
 *  2. build storage, the supervisor, the task manager
 *  3. build one BotRuntime per enabled bot and register them
 *  4. wire hot reload -> config reload / plugin reload
 *  5. install signal handlers for a graceful shutdown
 *
 * Anything that can fail is contained. The process exits only on an explicit
 * signal or an unrecoverable critical failure.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ConfigLoader } from './config/loader.js';
import type { ResolvedConfig } from './config/schema.js';
import { EventBus } from './core/event.js';
import { HotReloader, type ReloadEvent } from './core/hot-reload.js';
import { createLogger, type Logger } from './core/logger.js';
import { LogBuffer } from './core/log-buffer.js';
import { registries } from './core/registries.js';
import { Supervisor } from './core/supervisor.js';
import { TaskManager } from './core/task-manager.js';
import { BotRuntime } from './bot/runtime.js';
import { createStorage } from './storage/index.js';
import type { Storage } from './storage/types.js';
import { AdminServer } from './admin/server.js';
import type { OptionalRemoteDrivers } from './storage/remote-factory.js';
import { createRemoteRuntime, type RemoteRuntime } from './storage/remote-runtime.js';
import {ConfigPublicationStateMachine,InMemoryPublicationStateStore}from'./config/publication-state.js';
import{ConfigPublicationAdminAdapter}from'./config/publication-admin.js';
import{ProviderControlFacade}from'./admin/provider-control.js';
import { BotControlFacade } from './admin/bot-control.js';
import{OpsControlFacade}from'./admin/ops-control.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/** src/ -> project root */
const ROOT_DIR = process.env.MOHO_ROOT ?? process.cwd();

export interface RuntimeOptions {
  remoteDrivers?: OptionalRemoteDrivers;
  exit?: (code: number) => never | void;
}

export class Runtime {
  #logger: Logger;
  readonly #logs = new LogBuffer();
  #events: EventBus;
  #tasks!: TaskManager;
  #supervisor!: Supervisor;
  #storage?: Storage;
  #loader!: ConfigLoader;
  #config!: ResolvedConfig;
  #bots = new Map<string, BotRuntime>();
  #hotReload?: HotReloader;
  #admin?: AdminServer;
  #remote?: RemoteRuntime;
  #shuttingDown = false;
  readonly #options: RuntimeOptions;

  constructor(options: RuntimeOptions = {}) {
    this.#options = options;
    // Bootstrap logger; replaced once config is known.
    this.#logger = createLogger({ name: 'mohobot', sink: this.#logs });
    this.#events = new EventBus({
      onHandlerError: ({ event, error }) => {
        this.#logger.error({ event, err: error instanceof Error ? error.message : String(error) }, 'event handler failed');
      },
    });
  }

  async boot(): Promise<void> {
    this.#loader = new ConfigLoader({ rootDir: ROOT_DIR, logger: this.#logger, events: this.#events });
    this.#config = await this.#loader.load();

    this.#logger = createLogger({ name: 'mohobot', level: this.#config.global.logLevel, sink: this.#logs });
    this.#logger.info(
      { root: ROOT_DIR, bots: this.#config.bots.length, storage: this.#config.global.storage.driver },
      'MohoBot booting',
    );

    this.#tasks = new TaskManager({ logger: this.#logger, events: this.#events });
    this.#supervisor = new Supervisor({
      config: this.#config.global.supervisor,
      logger: this.#logger,
      events: this.#events,
    });
    this.#supervisor.installGlobalHandlers();
    this.#supervisor.onFatal((reason) => {
      this.#logger.fatal({ reason }, 'fatal condition; shutting down');
      void this.shutdown(1);
    });

    // Storage is optional: if it fails, the runtime degrades to memory-only.
    try {
      this.#storage = createStorage(this.#config.global.storage, { rootDir: ROOT_DIR, logger: this.#logger });
      await this.#storage.init();
      this.#logger.info({ driver: this.#config.global.storage.driver }, 'storage ready');
      this.#tasks.spawn(async () => void (await this.#storage?.purgeExpired()), {
        name: 'storage:purge',
        intervalMs: 300_000,
        timeoutMs: 30_000,
      });
    } catch (error) {
      const detail=error instanceof Error?error.message:String(error);
      if(this.#config.global.storage.driver==='sqlite'&&!this.#config.global.storage.allowEphemeralFallback){
        this.#logger.fatal({err:detail},'SQLite init/migration failed; refusing unsafe ephemeral fallback');
        throw error;
      }
      this.#logger.error({err:detail},'storage init failed; explicit ephemeral fallback enabled');
      this.#storage=undefined;
    }

    const remoteConfig = this.#config.global.remoteStorage;
    if (!this.#storage && remoteConfig.mode === 'remote-authoritative') {
      throw new Error('remote-authoritative requires initialized local coordination storage');
    }
    if (this.#storage) {
      this.#remote = createRemoteRuntime({
        config: remoteConfig,
        storage: this.#storage,
        events: this.#events,
        logger: this.#logger,
        drivers: this.#options.remoteDrivers,
      });
      this.#remote.coordinator.start();
      const remoteHealth = await this.#remote.coordinator.health();
      const unavailable = Object.entries(remoteHealth.remote)
        .filter(([, status]) => status.enabled && !status.ok)
        .map(([name]) => name);
      if (remoteConfig.mode === 'async-mirror' && unavailable.length > 0) {
        this.#logger.warn({ unavailable }, 'remote mirror degraded; local outbox remains authoritative');
      }
    }

    this.#logGatewayEvents();

    await this.#loadExtensions();

    for (const botConfig of this.#config.bots) {
      if (!botConfig.enabled) {
        this.#logger.info({ bot: botConfig.id }, 'bot disabled by config; skipping');
        continue;
      }
      const bot = new BotRuntime({
        config: botConfig,
        global: this.#config.global,
        rootDir: ROOT_DIR,
        events: this.#events,
        logger: this.#logger,
        tasks: this.#tasks,
        storage: this.#storage,
        registries,
      });
      this.#bots.set(botConfig.id, bot);
      // Not critical: one dead bot must never take the runtime with it.
      this.#supervisor.register(bot, { critical: false });
    }

    if (this.#bots.size === 0) {
      this.#logger.warn('no enabled bots found; runtime will idle');
    }

    await this.#supervisor.startAll();

    if (this.#config.global.hotReload.enabled) {
      this.#hotReload = new HotReloader({
        config: this.#config.global.hotReload,
        rootDir: ROOT_DIR,
        logger: this.#logger,
        onReload: (event) => this.#onReload(event),
      });
      await this.#hotReload.start();
    }

    const adminToken = this.#config.global.admin.token.trim();
    if (adminToken && this.#storage) {
      const publicationMachine=new ConfigPublicationStateMachine(new InMemoryPublicationStateStore());await publicationMachine.init();
      const publicationAdmin=new ConfigPublicationAdminAdapter(publicationMachine);
      const botControl = new BotControlFacade({
        snapshots: () => [...this.#bots.values()].map((bot) => bot.snapshot()),
        restart: async (botId) => {
          const bot = this.#bots.get(botId);
          return bot ? this.#supervisor.restartComponent(bot.name) : false;
        },
        reloadPlugin: async (botId, pluginId) => this.#bots.get(botId)?.reloadPlugin(pluginId) ?? false,
      });
      this.#admin = new AdminServer({
        rootDir: ROOT_DIR,
        host: this.#config.global.admin.host,
        port: this.#config.global.admin.port,
        token: adminToken,
        logger: this.#logger,
        storage: this.#storage,
        snapshots: () => [...this.#bots.values()].map((bot) => bot.snapshot()),
        botControl,
        modelHealth: async () => botControl.modelHealth(),
        remoteHealth: this.#remote ? () => this.#remote!.coordinator.health() : undefined,
        configPublication:publicationAdmin,
        ops:new OpsControlFacade({storage:this.#storage,listTasks:()=>this.#tasks.list()}),
        logs:this.#logs,
        providers:new ProviderControlFacade({bots:()=>this.#config.bots,logger:this.#logger}),
      });
      await this.#admin.start();
    } else {
      this.#logger.info(adminToken ? 'admin WebUI disabled; persistent storage is required' : 'admin WebUI disabled; set MOHO_ADMIN_TOKEN in .env.local to enable it');
    }

    this.#installSignalHandlers();

    const running = this.#supervisor.status().filter((s) => s.state === 'running').length;
    this.#logger.info({ running, total: this.#bots.size }, 'MohoBot is up');
  }

  /** Hot reload dispatcher. Failure keeps the previous version running. */
  async #onReload(event: ReloadEvent): Promise<void> {
    if (event.kind === 'config') {
      const next = await this.#loader.reload();
      // Restart only bots whose config actually changed.
      for (const botConfig of next.bots) {
        const bot = this.#bots.get(botConfig.id);
        if (!bot) {
          this.#logger.info({ bot: botConfig.id }, 'new bot in config; restart required to activate');
          continue;
        }
        const before = JSON.stringify(this.#config.bots.find((b) => b.id === botConfig.id));
        const after = JSON.stringify(botConfig);
        if (before === after) continue;
        this.#logger.info({ bot: botConfig.id }, 'bot config changed; restarting');
        bot.applyConfig(botConfig);
        await this.#supervisor.restartComponent(bot.name);
      }
      this.#config = next;
      return;
    }

    if (event.kind === 'plugin' && event.target) {
      for (const bot of this.#bots.values()) {
        if (event.action === 'unlink') {
          await bot.unloadPlugin(event.target);
        } else {
          const ok = await bot.reloadPlugin(event.target);
          this.#logger.info({ plugin: event.target, bot: bot.id, ok }, 'plugin reload result');
        }
      }
    }
  }

  /**
   * Load `extensions/*.ts` before any bot starts.
   *
   * This is the non-plugin extension path: a module here gets the registries
   * and can add AI providers, gateways, storage drivers or memory adapters.
   * The directory is optional, and one broken extension never blocks boot.
   */
  async #loadExtensions(): Promise<void> {
    const dir = path.join(ROOT_DIR, 'extensions');
    let entries: string[];
    try {
      entries = (await fs.readdir(dir)).filter((f) => /\.(ts|js|mjs)$/.test(f) && !f.endsWith('.d.ts')).sort();
    } catch {
      return; // no extensions/ directory - perfectly normal
    }

    for (const file of entries) {
      const full = path.join(dir, file);
      try {
        const mod: unknown = await import(`${pathToFileURL(full).href}?v=${Date.now()}`);
        const register = (mod as { register?: unknown; default?: unknown }).register
          ?? (mod as { default?: unknown }).default;
        if (typeof register === 'function') {
          await (register as (r: typeof registries, l: Logger) => unknown)(registries, this.#logger);
        }
        this.#logger.info({ extension: file }, 'extension loaded');
      } catch (error) {
        this.#logger.error(
          { extension: file, err: error instanceof Error ? error.message : String(error) },
          'extension failed to load (skipped)',
        );
      }
    }

    this.#logger.info(
      {
        providers: registries.providers.names(),
        gateways: registries.gateways.names(),
        storages: registries.storages.names(),
        memories: registries.memories.names(),
      },
      'extension registries ready',
    );
  }

  #logGatewayEvents(): void {
    this.#events.on('gateway:ready', ({ botId, username }) =>
      this.#logger.info({ bot: botId, username }, 'gateway ready'),
    );
    this.#events.on('gateway:disconnect', ({ botId, reason }) => {
      this.#logger.warn({ bot: botId, reason }, 'gateway disconnected');
    });
    this.#events.on('gateway:error', ({ botId, error }) => {
      this.#logger.error({ bot: botId, err: error }, 'gateway error');
    });
    this.#events.on('plugin:error', ({ pluginId, error, phase }) => {
      this.#logger.warn({ plugin: pluginId, phase, err: error }, 'plugin error');
    });
  }

  #installSignalHandlers(): void {
    const onSignal = (signal: NodeJS.Signals) => {
      this.#logger.info({ signal }, 'signal received');
      void this.shutdown(0);
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }

  async shutdown(code: number): Promise<void> {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    this.#logger.info('shutting down');

    const timeout = setTimeout(() => {
      this.#logger.error('graceful shutdown timed out; forcing exit');
      (this.#options.exit ?? process.exit)(code === 0 ? 1 : code);
    }, this.#config?.global.supervisor.shutdownTimeoutMs ?? 10_000);
    timeout.unref?.();

    try {
      await this.#admin?.stop();
      await this.#hotReload?.stop();
      await this.#tasks?.stopAll(3000);
      await this.#supervisor?.shutdown();
      await this.#remote?.stopEventBridge();
      await this.#remote?.coordinator.stop();
      await this.#storage?.close();
    } catch (error) {
      this.#logger.error({ err: error instanceof Error ? error.message : String(error) }, 'shutdown error');
    } finally {
      clearTimeout(timeout);
      this.#logger.info('bye');
      (this.#options.exit ?? process.exit)(code);
    }
  }
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const runtime = new Runtime();
  runtime.boot().catch((error: unknown) => {
    // Boot failure is the ONE place where exiting is correct: nothing is running yet.
    console.error('[mohobot] fatal boot error:', error instanceof Error ? error.stack : error);
    process.exit(1);
  });
}
