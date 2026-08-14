import type { BotSnapshot } from '../bot/runtime.js';

export interface GatewayControlView {
  connected: boolean;
  ping: number;
  username?: string;
  guilds?: number;
  reconnects: number;
}

export interface PluginControlView {
  id: string;
  state: string;
  errors: number;
}

export interface BotControlView {
  id: string;
  name: string;
  running: boolean;
  adapter: string;
  gateway: GatewayControlView;
  plugins: PluginControlView[];
  modelHealth?: unknown;
}

export interface BotControlFacadeOptions {
  snapshots: () => BotSnapshot[];
  restart: (botId: string) => Promise<boolean>;
  reloadPlugin: (botId: string, pluginId: string) => Promise<boolean>;
}

export type BotControlErrorCode = 'bot_not_found'|'plugin_not_found'|'busy'|'restart_failed'|'plugin_reload_failed';

export class BotControlError extends Error {
  constructor(readonly code: BotControlErrorCode, message = code) {
    super(message);
    this.name = 'BotControlError';
  }
}

function gatewayView(snapshot: BotSnapshot): GatewayControlView {
  const gateway: GatewayControlView = {
    connected: snapshot.gateway.connected === true,
    ping: Number.isFinite(snapshot.gateway.ping) ? snapshot.gateway.ping : -1,
    reconnects: Number.isSafeInteger(snapshot.gateway.reconnects) && snapshot.gateway.reconnects >= 0
      ? snapshot.gateway.reconnects
      : 0,
  };
  if (typeof snapshot.gateway.username === 'string' && snapshot.gateway.username.length > 0) gateway.username = snapshot.gateway.username;
  if (Number.isSafeInteger(snapshot.gateway.guilds) && snapshot.gateway.guilds! >= 0) gateway.guilds = snapshot.gateway.guilds;
  return gateway;
}

function pluginViews(snapshot: BotSnapshot): PluginControlView[] {
  return snapshot.plugins.map((plugin) => ({ id: plugin.id, state: plugin.state, errors: plugin.errors }));
}

function botView(snapshot: BotSnapshot): BotControlView {
  return {
    id: snapshot.id,
    name: snapshot.name,
    running: snapshot.running,
    adapter: snapshot.adapter,
    gateway: gatewayView(snapshot),
    plugins: pluginViews(snapshot),
    ...(snapshot.modelHealth === undefined ? {} : { modelHealth: structuredClone(snapshot.modelHealth) }),
  };
}

/** Narrow control plane. Runtime internals never cross this boundary. */
export class BotControlFacade {
  readonly #opts: BotControlFacadeOptions;
  readonly #busy = new Set<string>();

  constructor(options: BotControlFacadeOptions) {
    this.#opts = options;
  }

  list(): BotControlView[] {
    return this.#opts.snapshots().map(botView);
  }

  get(botId: string): BotControlView {
    const snapshot = this.#snapshot(botId);
    return botView(snapshot);
  }

  gateway(botId: string): GatewayControlView {
    return gatewayView(this.#snapshot(botId));
  }

  plugins(botId: string): PluginControlView[] {
    return pluginViews(this.#snapshot(botId));
  }

  modelHealth(): Record<string, unknown> {
    return Object.fromEntries(this.#opts.snapshots().map((snapshot) => [snapshot.id, snapshot.modelHealth ?? { configured: false }]));
  }

  async restart(botId: string): Promise<BotControlView> {
    return this.#exclusive(botId, async () => {
      try {
        if (!await this.#opts.restart(botId)) throw new BotControlError('restart_failed');
        return this.get(botId);
      } catch (error) {
        if (error instanceof BotControlError) throw error;
        throw new BotControlError('restart_failed');
      }
    });
  }

  async reloadPlugin(botId: string, pluginId: string): Promise<PluginControlView> {
    if (!pluginId || pluginId !== encodeURIComponent(pluginId) || pluginId === '.' || pluginId === '..') {
      throw new BotControlError('plugin_not_found');
    }
    return this.#exclusive(botId, async () => {
      const current = this.plugins(botId).find((plugin) => plugin.id === pluginId);
      if (!current) throw new BotControlError('plugin_not_found');
      try {
        if (!await this.#opts.reloadPlugin(botId, pluginId)) throw new BotControlError('plugin_reload_failed');
        const reloaded = this.plugins(botId).find((plugin) => plugin.id === pluginId);
        if (!reloaded) throw new BotControlError('plugin_reload_failed');
        return reloaded;
      } catch (error) {
        if (error instanceof BotControlError) throw error;
        throw new BotControlError('plugin_reload_failed');
      }
    });
  }

  #snapshot(botId: string): BotSnapshot {
    const snapshot = this.#opts.snapshots().find((candidate) => candidate.id === botId);
    if (!snapshot) throw new BotControlError('bot_not_found');
    return snapshot;
  }

  async #exclusive<T>(botId: string, operation: () => Promise<T>): Promise<T> {
    this.#snapshot(botId);
    if (this.#busy.has(botId)) throw new BotControlError('busy');
    this.#busy.add(botId);
    try {
      return await operation();
    } finally {
      this.#busy.delete(botId);
    }
  }
}
