/**
 * MohoBot event system.
 *
 * Discord events are translated into Moho events by the gateway adapter.
 * No module outside src/discord/ may import discord.js.
 */

import type { BotId, MohoMessage, PluginId } from './types.js';

export interface MohoEventMap {
  /** A user-visible message arrived on some gateway. */
  'message:create': { message: MohoMessage };
  /** A slash command / interaction arrived. */
  'interaction:create': {
    botId: BotId;
    name: string;
    channelId: string;
    userId: string;
    options: Record<string, unknown>;
    /** Adapter-provided reply function; already error-wrapped by the adapter. */
    reply: (content: string) => Promise<void>;
  };

  'gateway:ready': { botId: BotId; username: string };
  'gateway:disconnect': { botId: BotId; reason: string };
  'gateway:error': { botId: BotId; error: string };

  'bot:started': { botId: BotId };
  'bot:stopped': { botId: BotId };
  'bot:crashed': { botId: BotId; error: string };

  'plugin:loaded': { pluginId: PluginId };
  'plugin:unloaded': { pluginId: PluginId };
  'plugin:error': { pluginId: PluginId; error: string; phase: string };

  'ai:request': { botId: BotId; model: string; messages: number };
  'ai:response': { botId: BotId; model: string; ms: number; tokens?: number };
  'ai:error': { botId: BotId; error: string; attempt: number };

  'config:reload': { path: string };
  'config:reload:failed': { path: string; error: string };

  'task:start': { taskId: string; name: string };
  'task:done': { taskId: string; name: string; ms: number };
  'task:error': { taskId: string; name: string; error: string };
}

export type MohoEventName = keyof MohoEventMap;
export type MohoEventPayload<K extends MohoEventName> = MohoEventMap[K];
export type MohoEventHandler<K extends MohoEventName> = (
  payload: MohoEventPayload<K>,
) => void | Promise<void>;

export interface EventBusOptions {
  /** Called when a handler throws/rejects. Must never itself throw. */
  onHandlerError?: (info: { event: string; error: unknown }) => void;
}

/**
 * Tiny typed event bus.
 *
 * Hard rule: a throwing subscriber can never take down the emitter, and an
 * async subscriber's rejection can never become an unhandled rejection.
 */
export class EventBus {
  readonly #handlers = new Map<string, Set<(p: unknown) => unknown>>();
  readonly #onHandlerError: NonNullable<EventBusOptions['onHandlerError']>;

  constructor(options: EventBusOptions = {}) {
    this.#onHandlerError = options.onHandlerError ?? (() => {});
  }

  on<K extends MohoEventName>(event: K, handler: MohoEventHandler<K>): () => void {
    const set = this.#handlers.get(event) ?? new Set();
    set.add(handler as (p: unknown) => unknown);
    this.#handlers.set(event, set);
    return () => this.off(event, handler);
  }

  once<K extends MohoEventName>(event: K, handler: MohoEventHandler<K>): () => void {
    const off = this.on(event, ((payload: MohoEventPayload<K>) => {
      off();
      return handler(payload);
    }) as MohoEventHandler<K>);
    return off;
  }

  off<K extends MohoEventName>(event: K, handler: MohoEventHandler<K>): void {
    const set = this.#handlers.get(event);
    if (!set) return;
    set.delete(handler as (p: unknown) => unknown);
    if (set.size === 0) this.#handlers.delete(event);
  }

  /** Fire and forget. Never throws, never rejects. */
  emit<K extends MohoEventName>(event: K, payload: MohoEventPayload<K>): void {
    const set = this.#handlers.get(event);
    if (!set || set.size === 0) return;
    for (const handler of [...set]) {
      try {
        const result = handler(payload);
        if (result instanceof Promise) {
          result.catch((error: unknown) => this.#reportError(event, error));
        }
      } catch (error) {
        this.#reportError(event, error);
      }
    }
  }

  /** Await every subscriber. Individual failures are isolated and reported. */
  async emitAsync<K extends MohoEventName>(
    event: K,
    payload: MohoEventPayload<K>,
  ): Promise<void> {
    const set = this.#handlers.get(event);
    if (!set || set.size === 0) return;
    await Promise.all(
      [...set].map(async (handler) => {
        try {
          await handler(payload);
        } catch (error) {
          this.#reportError(event, error);
        }
      }),
    );
  }

  listenerCount(event: MohoEventName): number {
    return this.#handlers.get(event)?.size ?? 0;
  }

  removeAll(): void {
    this.#handlers.clear();
  }

  #reportError(event: string, error: unknown): void {
    try {
      this.#onHandlerError({ event, error });
    } catch {
      /* the error reporter itself must never escalate */
    }
  }
}
