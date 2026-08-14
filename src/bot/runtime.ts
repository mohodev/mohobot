/**
 * BotRuntime - one self-contained bot instance.
 *
 * Owns its gateway, provider, sessions, plugins and pipeline. Registered with
 * the Supervisor as a Managed component, so a crash here restarts only THIS
 * bot; sibling bots and the runtime keep going.
 */

import path from 'node:path';
import type { GlobalConfig, ResolvedBotConfig } from '../config/schema.js';
import type { EventBus } from '../core/event.js';
import type { Logger } from '../core/logger.js';
import type { TaskManager } from '../core/task-manager.js';
import type { Managed, MohoMessage, OutboundMessage } from '../core/types.js';
import type { Registries } from '../core/registries.js';
import { createProvider } from '../ai/index.js';
import type { AIProvider } from '../ai/types.js';
import { MultiProviderRouter } from '../ai/multi-router.js';
import { HealthCoordinator, type HealthSnapshot } from '../ai/health-coordinator.js';
import { createGateway } from '../discord/index.js';
import type { Gateway, GatewayStatus } from '../discord/types.js';
import { SessionManager } from '../session/manager.js';
import { PluginManager } from '../plugins/manager.js';
import { MessagePipeline, type PipelineStats } from '../pipeline/pipeline.js';
import { scopeStorage } from '../storage/index.js';
import type { MemoryAdapter, Storage } from '../storage/types.js';
import { WorldStore } from '../admin/world.js';
import { MessageSync } from '../session/message-sync.js';
import { ThreadLifecycleStore } from '../session/thread-lifecycle.js';
import { SafeMediaDownloader } from '../media/downloader.js';
import { VisionRouter } from '../media/vision.js';
import { MediaRuntime } from '../media/runtime.js';
import { OpenAICompatibleOcrProvider, OpenAICompatibleVisionProvider } from '../media/openai-compatible.js';

export interface BotRuntimeDeps {
  config: ResolvedBotConfig;
  global: GlobalConfig;
  rootDir: string;
  events: EventBus;
  logger: Logger;
  tasks: TaskManager;
  storage?: Storage;
  /** Extension registries. Defaults to the process-wide ones. */
  registries: Registries;
}

export interface BotSnapshot {
  id: string;
  name: string;
  running: boolean;
  adapter: string;
  model: string;
  provider: string;
  gateway: GatewayStatus;
  sessions: number;
  plugins: { id: string; state: string; errors: number }[];
  pipeline: PipelineStats;
  modelHealth?: HealthSnapshot;
}

export class BotRuntime implements Managed {
  readonly name: string;
  readonly #deps: BotRuntimeDeps;
  readonly #logger: Logger;
  #config: ResolvedBotConfig;

  #gateway?: Gateway;
  #provider?: AIProvider;
  #sessions?: SessionManager;
  #plugins?: PluginManager;
  #pipeline?: MessagePipeline;
  #unsubscribe: Array<() => void> = [];
  #sweepTaskId?: string;
  #worldTickTaskId?: string;
  #healthTaskId?: string;
  #health?: HealthCoordinator;
  #running = false;

  constructor(deps: BotRuntimeDeps) {
    this.#deps = deps;
    this.#config = deps.config;
    this.name = `bot:${deps.config.id}`;
    this.#logger = deps.logger.child({ bot: deps.config.id });
  }

  get id(): string {
    return this.#config.id;
  }

  get running(): boolean {
    return this.#running;
  }

  get pluginManager(): PluginManager | undefined {
    return this.#plugins;
  }

  async start(): Promise<void> {
    if (this.#running) return;
    const cfg = this.#config;
    this.#logger.info({ adapter: cfg.adapter, model: cfg.ai.model }, 'starting bot');

    // Long-term memory is an extension point: resolved from the registry so a
    // plugin can supply a vector/graph adapter with no change to this file.
    const memoryCfg = cfg.memory;
    let memory: MemoryAdapter | undefined;
    if (memoryCfg.enabled) {
      const factory = this.#deps.registries.memories.resolve(memoryCfg.adapter, 'null', this.#logger);
      try {
        memory = factory({
          botId: cfg.id,
          logger: this.#logger,
          storage: this.#deps.storage,
          options: memoryCfg.options,
        });
      } catch (error) {
        this.#logger.warn(
          { adapter: memoryCfg.adapter, err: String(error) },
          'memory adapter construction failed; continuing without long-term memory',
        );
      }
    }

    this.#sessions = new SessionManager({
      botId: cfg.id,
      config: cfg.session,
      storage: this.#deps.storage,
      logger: this.#logger,
      memory,
    });

    this.#gateway = createGateway(cfg, { events: this.#deps.events, logger: this.#logger });

    const send = async (out: OutboundMessage): Promise<void> => {
      if (!this.#gateway) throw new Error('gateway not started');
      await this.#gateway.send(out);
    };

    if (this.#deps.global.plugins.enabled) {
      const pluginDir = path.isAbsolute(this.#deps.global.plugins.dir)
        ? this.#deps.global.plugins.dir
        : path.join(this.#deps.rootDir, this.#deps.global.plugins.dir);
      this.#plugins = new PluginManager({
        dir: pluginDir,
        logger: this.#logger,
        events: this.#deps.events,
        hookTimeoutMs: this.#deps.global.plugins.hookTimeoutMs,
        maxErrors: this.#deps.global.plugins.maxErrors,
        allow: this.#deps.global.plugins.allow,
        deny: [...this.#deps.global.plugins.deny, ...cfg.disabledPlugins],
        storageFor: this.#deps.storage
          ? (pluginId) => scopeStorage(this.#deps.storage!, `plugin:${cfg.id}:${pluginId}`)
          : undefined,
        send,
        botConfig: cfg,
        registries: this.#deps.registries,
        pipelineHandle: (message) => this.#pipeline?.handle(message) ?? Promise.resolve(),
        sessions: this.#sessions,
      });
      // A broken plugin directory must not stop the bot from booting.
      // Plugins register their AI providers / gateways here, so this MUST run
      // before createProvider() below - otherwise a plugin-supplied provider
      // named in ai.provider would be unknown at resolution time.
      await this.#plugins.loadAll();
    }

    // Resolve the AI provider AFTER plugins have loaded, so a provider a
    // plugin registered (e.g. kilo) is selectable via ai.provider. Built-in
    // providers and extensions/*.ts are already registered by this point.
    this.#provider = createProvider(cfg.ai, {
      logger: this.#logger,
      events: this.#deps.events,
      botId: cfg.id,
    });
    if (this.#provider instanceof MultiProviderRouter) {
      this.#health = new HealthCoordinator({ router: this.#provider, logger: this.#logger });
      this.#healthTaskId = this.#health.start(this.#deps.tasks);
    }

    let media: MediaRuntime | undefined;
    if (cfg.media.enabled && (cfg.media.vision.enabled || cfg.media.ocr.enabled)) {
      const vision = cfg.media.vision.enabled ? new OpenAICompatibleVisionProvider(cfg.media.vision) : undefined;
      const ocr = cfg.media.ocr.enabled ? new OpenAICompatibleOcrProvider(cfg.media.ocr) : undefined;
      media = new MediaRuntime({
        downloader: new SafeMediaDownloader({ maxBytes: cfg.media.maxFileBytes, hostAllowlist: cfg.media.hostAllowlist }),
        vision: new VisionRouter({ vision, ocr, maxVisionBytes: cfg.media.maxFileBytes, maxOcrBytes: cfg.media.maxFileBytes, cacheTtlMs: cfg.media.cacheTtlMs }),
        maxAttachments: cfg.media.maxAttachments,
        maxTotalBytes: cfg.media.maxTotalBytes,
        concurrency: cfg.media.concurrency,
        cacheTtlMs: cfg.media.cacheTtlMs,
      });
    }

    this.#pipeline = new MessagePipeline({
      config: cfg,
      provider: this.#provider,
      sessions: this.#sessions,
      plugins: this.#plugins,
      events: this.#deps.events,
      logger: this.#logger,
      send,
      media,
      typing: async (channelId) => {
        await this.#gateway?.typing(channelId);
      },
    });

    // Only react to events addressed to THIS bot.
    const messageSync = this.#deps.storage ? new MessageSync({ storage: this.#deps.storage }) : undefined;
    const threadLifecycle = this.#deps.storage ? new ThreadLifecycleStore(this.#deps.storage, this.#logger) : undefined;
    this.#unsubscribe.push(
      this.#deps.events.on('message:create', ({ message }) => {
        if (message.botId !== cfg.id) return;
        void this.#pipeline?.handle(message as MohoMessage);
      }),
      this.#deps.events.on('message:update', (event) => {
        if (event.botId !== cfg.id) return;
        void (async () => {
          const indexed = messageSync ? await messageSync.update(event) : undefined;
          const content = indexed?.content ?? event.content;
          if (content === undefined || indexed?.tombstone) return;
          await this.#sessions?.updateSourceMessage({
            botId: event.botId,
            channelId: event.location.channelId,
            userId: event.authorId ?? indexed?.authorId,
            sourceMessageId: event.messageId,
            sourcePlatform: event.platform,
            content,
          });
        })().catch((error) => this.#logger.warn({ err: error }, 'message update correction failed'));
      }),
      this.#deps.events.on('message:delete', (event) => {
        if (event.botId !== cfg.id) return;
        void (async () => {
          const indexed = messageSync ? await messageSync.delete(event) : undefined;
          await this.#sessions?.deleteSourceMessage({
            botId: event.botId,
            channelId: event.location.channelId,
            userId: event.authorId ?? indexed?.authorId,
            sourceMessageId: event.messageId,
            sourcePlatform: event.platform,
          });
        })().catch((error) => this.#logger.warn({ err: error }, 'message delete correction failed'));
      }),
      this.#deps.events.on('thread:lifecycle', (event) => {
        if (event.botId !== cfg.id || !threadLifecycle || !this.#sessions) return;
        void threadLifecycle.apply(event, cfg.session, this.#sessions)
          .catch((error) => this.#logger.warn({ err: error }, 'thread lifecycle sync failed'));
      }),
      this.#deps.events.on('interaction:create', ({ botId, name, userId, reply }) => {
        if (botId !== cfg.id || name !== 'status' || !cfg.admin.enabled || !cfg.admin.userIds.includes(userId)) return;
        const snapshot = this.snapshot();
        void reply(`状态：${snapshot.running ? '运行中' : '已停止'}\n网关：${snapshot.gateway.connected ? '已连接' : '未连接'}\n模型：${snapshot.provider} / ${snapshot.model}\n会话：${snapshot.sessions}｜已回复：${snapshot.pipeline.replied}｜AI 失败：${snapshot.pipeline.aiFailures}`);
      }),
    );

    await this.#gateway.start();

    // Periodic housekeeping - owned by the TaskManager, never a bare interval.
    this.#sweepTaskId = this.#deps.tasks.spawn(
      async () => {
        const removed = (await this.#sessions?.sweep()) ?? 0;
        this.#pipeline?.sweep();
        if (removed > 0) this.#logger.debug({ removed }, 'idle sessions swept');
      },
      { name: `${this.name}:sweep`, intervalMs: 60_000, timeoutMs: 10_000 },
    );

    this.#worldTickTaskId = this.#deps.tasks.spawn(
      async () => { await new WorldStore(this.#deps.rootDir).tick(); },
      { name: `${this.name}:world-tick`, intervalMs: 60_000, timeoutMs: 5_000 },
    );

    this.#running = true;
    this.#deps.events.emit('bot:started', { botId: cfg.id });
    this.#logger.info('bot started');
  }

  async stop(): Promise<void> {
    if (!this.#running && !this.#gateway) return;
    this.#logger.info('stopping bot');

    for (const off of this.#unsubscribe) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    this.#unsubscribe = [];

    if (this.#sweepTaskId) {
      this.#deps.tasks.cancel(this.#sweepTaskId);
      this.#sweepTaskId = undefined;
    }
    if (this.#worldTickTaskId) {
      this.#deps.tasks.cancel(this.#worldTickTaskId);
      this.#worldTickTaskId = undefined;
    }
    if (this.#healthTaskId) {
      this.#deps.tasks.cancel(this.#healthTaskId);
      this.#healthTaskId = undefined;
    }
    this.#health = undefined;

    // Each teardown step is independent - one failure must not skip the rest.
    try {
      await this.#plugins?.unloadAll();
    } catch (error) {
      this.#logger.warn({ err: String(error) }, 'plugin unload failed');
    }
    try {
      // Drain pending background session writes so shutdown loses no context.
      await this.#sessions?.flush();
    } catch (error) {
      this.#logger.warn({ err: String(error) }, 'session flush failed');
    }
    try {
      await this.#gateway?.stop();
    } catch (error) {
      this.#logger.warn({ err: String(error) }, 'gateway stop failed');
    }

    this.#pipeline?.stop();
    this.#gateway = undefined;
    this.#pipeline = undefined;
    this.#plugins = undefined;
    this.#provider = undefined;
    this.#sessions = undefined;
    this.#running = false;
    this.#deps.events.emit('bot:stopped', { botId: this.#config.id });
  }

  /** Apply a new config on the next (re)start. Used by hot reload. */
  applyConfig(config: ResolvedBotConfig): void {
    this.#config = config;
  }

  /** Reload plugins without restarting the gateway. */
  async reloadPlugin(pluginId: string): Promise<boolean> {
    if (!this.#plugins) return false;
    return this.#plugins.load(pluginId);
  }

  async unloadPlugin(pluginId: string): Promise<void> {
    await this.#plugins?.unload(pluginId);
  }

  /** Debug-only provider access. It deliberately excludes pipeline, gateway and state stores. */
  debugProvider(): AIProvider | undefined { return this.#provider; }

  snapshot(): BotSnapshot {
    return {
      id: this.#config.id,
      name: this.#config.name,
      running: this.#running,
      adapter: this.#config.adapter,
      model: this.#provider?.model ?? this.#config.ai.model,
      provider: this.#provider?.name ?? 'none',
      gateway: this.#gateway?.status() ?? { connected: false, ping: -1, reconnects: 0 },
      sessions: this.#sessions?.size() ?? 0,
      plugins: (this.#plugins?.list() ?? []).map((p) => ({ id: p.id, state: p.state, errors: p.errors })),
      pipeline: this.#pipeline?.stats() ?? {
        handled: 0,
        replied: 0,
        skipped: 0,
        aiFailures: 0,
        rateLimited: 0,
      },
      ...(this.#health ? { modelHealth: this.#health.snapshot() } : {}),
    };
  }
}
