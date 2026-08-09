/**
 * Supervisor - the runtime's protective shell.
 *
 * Owns component lifecycles, isolates failures, restarts what died with
 * exponential backoff, and converts process-level catastrophes
 * (unhandledRejection / uncaughtException) into logged, survivable events.
 *
 * Design goal: 7x24 operation. Nothing below the Supervisor may kill the process.
 */

import type { SupervisorConfig } from '../config/schema.js';
import type { EventBus } from './event.js';
import type { Logger } from './logger.js';
import type { ComponentState, ComponentStatus, Managed } from './types.js';

interface Entry {
  component: Managed;
  status: ComponentStatus;
  /** Restart timestamps inside the current window. */
  restartTimes: number[];
  restartTimer?: NodeJS.Timeout;
  /** Optional per-component restart hook (e.g. rebuild before restart). */
  onRestart?: () => Promise<void>;
  critical: boolean;
}

export interface RegisterOptions {
  /** A critical component that exhausts its restarts stops the whole runtime. */
  critical?: boolean;
  /** Called before each restart attempt; may recreate internal state. */
  onRestart?: () => Promise<void>;
}

export class Supervisor {
  readonly #entries = new Map<string, Entry>();
  readonly #config: SupervisorConfig;
  readonly #logger: Logger;
  readonly #events: EventBus;
  #installed = false;
  #shuttingDown = false;
  #processHandlers: Array<{ event: string; handler: (...args: any[]) => void }> = [];
  #onFatal?: (reason: string) => void;

  constructor(deps: { config: SupervisorConfig; logger: Logger; events: EventBus }) {
    this.#config = deps.config;
    this.#logger = deps.logger.child({ component: 'supervisor' });
    this.#events = deps.events;
  }

  /** Called when a critical component is unrecoverable. */
  onFatal(handler: (reason: string) => void): void {
    this.#onFatal = handler;
  }

  register(component: Managed, options: RegisterOptions = {}): void {
    if (this.#entries.has(component.name)) {
      throw new Error(`component "${component.name}" already registered`);
    }
    this.#entries.set(component.name, {
      component,
      status: { name: component.name, state: 'stopped', since: Date.now(), restarts: 0 },
      restartTimes: [],
      critical: options.critical ?? false,
      onRestart: options.onRestart,
    });
  }

  unregister(name: string): void {
    const entry = this.#entries.get(name);
    if (!entry) return;
    if (entry.restartTimer) clearTimeout(entry.restartTimer);
    this.#entries.delete(name);
  }

  has(name: string): boolean {
    return this.#entries.has(name);
  }

  /** Install process-level guards. Idempotent. */
  installGlobalHandlers(): void {
    if (this.#installed) return;
    this.#installed = true;

    const onUnhandled = (reason: unknown) => {
      const msg = reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason);
      this.#logger.error({ err: msg }, 'unhandled promise rejection (contained)');
      if (this.#config.crashOnUnhandled) this.#onFatal?.('unhandledRejection');
    };
    const onUncaught = (error: Error) => {
      this.#logger.fatal({ err: error }, 'uncaught exception (contained)');
      if (this.#config.crashOnUnhandled) this.#onFatal?.('uncaughtException');
    };
    const onWarning = (warning: Error) => {
      this.#logger.warn({ name: warning.name, msg: warning.message }, 'process warning');
    };

    process.on('unhandledRejection', onUnhandled);
    process.on('uncaughtException', onUncaught);
    process.on('warning', onWarning);
    this.#processHandlers = [
      { event: 'unhandledRejection', handler: onUnhandled },
      { event: 'uncaughtException', handler: onUncaught },
      { event: 'warning', handler: onWarning },
    ];
  }

  removeGlobalHandlers(): void {
    for (const { event, handler } of this.#processHandlers) {
      process.off(event as NodeJS.Signals, handler);
    }
    this.#processHandlers = [];
    this.#installed = false;
  }

  /** Start one component. Failure is isolated and scheduled for retry. */
  async startComponent(name: string): Promise<boolean> {
    const entry = this.#entries.get(name);
    if (!entry) return false;
    if (entry.status.state === 'running' || entry.status.state === 'starting') return true;
    this.#setState(entry, 'starting');
    try {
      await entry.component.start();
      this.#setState(entry, 'running');
      this.#logger.info({ component: name }, 'component started');
      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      entry.status.lastError = msg;
      this.#setState(entry, 'crashed');
      this.#logger.error({ component: name, err: msg }, 'component failed to start');
      this.#scheduleRestart(entry);
      return false;
    }
  }

  /** Start every registered component; one failure does not block the others. */
  async startAll(): Promise<void> {
    for (const name of this.#entries.keys()) {
      await this.startComponent(name);
    }
  }

  async stopComponent(name: string): Promise<void> {
    const entry = this.#entries.get(name);
    if (!entry) return;
    if (entry.restartTimer) {
      clearTimeout(entry.restartTimer);
      entry.restartTimer = undefined;
    }
    if (entry.status.state === 'stopped') return;
    this.#setState(entry, 'stopping');
    try {
      await this.#withTimeout(entry.component.stop(), this.#config.shutdownTimeoutMs, name);
      this.#logger.info({ component: name }, 'component stopped');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.#logger.warn({ component: name, err: msg }, 'component stop failed (forcing stopped)');
    } finally {
      this.#setState(entry, 'stopped');
    }
  }

  /**
   * Report that a running component died. Called by the component itself or by
   * whoever notices (e.g. a gateway disconnect handler).
   */
  reportFailure(name: string, error: unknown): void {
    const entry = this.#entries.get(name);
    if (!entry) return;
    const msg = error instanceof Error ? error.message : String(error);
    entry.status.lastError = msg;
    this.#setState(entry, 'crashed');
    this.#logger.error({ component: name, err: msg }, 'component crashed');
    this.#scheduleRestart(entry);
  }

  /** Stop then start a component immediately, bypassing backoff. */
  async restartComponent(name: string): Promise<boolean> {
    const entry = this.#entries.get(name);
    if (!entry) return false;
    await this.stopComponent(name);
    if (entry.onRestart) {
      try {
        await entry.onRestart();
      } catch (error) {
        this.#logger.error(
          { component: name, err: error instanceof Error ? error.message : String(error) },
          'onRestart hook failed',
        );
      }
    }
    entry.status.restarts += 1;
    return this.startComponent(name);
  }

  status(): ComponentStatus[] {
    return [...this.#entries.values()].map((e) => ({ ...e.status }));
  }

  /** True when every registered component is running. */
  healthy(): boolean {
    return [...this.#entries.values()].every((e) => e.status.state === 'running');
  }

  async shutdown(): Promise<void> {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    this.#logger.info('supervisor shutting down');
    // Reverse registration order so dependents stop before their dependencies.
    for (const name of [...this.#entries.keys()].reverse()) {
      await this.stopComponent(name);
    }
    this.removeGlobalHandlers();
  }

  #scheduleRestart(entry: Entry): void {
    if (this.#shuttingDown || !this.#config.autoRestart) return;
    const now = Date.now();
    entry.restartTimes = entry.restartTimes.filter((t) => now - t < this.#config.restartWindowMs);

    if (entry.restartTimes.length >= this.#config.maxRestarts) {
      this.#logger.error(
        { component: entry.component.name, restarts: entry.restartTimes.length },
        'restart limit reached; component left down',
      );
      if (entry.critical) this.#onFatal?.(`critical component "${entry.component.name}" is unrecoverable`);
      return;
    }

    const attempt = entry.restartTimes.length;
    const delay = Math.min(this.#config.backoffBaseMs * 2 ** attempt, this.#config.backoffMaxMs);
    const jitter = Math.floor(delay * 0.2 * (Math.random() * 2 - 1));
    const wait = Math.max(100, delay + jitter);

    entry.restartTimes.push(now);
    entry.status.restarts += 1;
    this.#logger.warn({ component: entry.component.name, inMs: wait, attempt: attempt + 1 }, 'scheduling restart');

    if (entry.restartTimer) clearTimeout(entry.restartTimer);
    const timer = setTimeout(() => {
      entry.restartTimer = undefined;
      void (async () => {
        try {
          await this.stopComponent(entry.component.name);
          if (entry.onRestart) await entry.onRestart();
          await this.startComponent(entry.component.name);
        } catch (error) {
          this.#logger.error(
            { component: entry.component.name, err: error instanceof Error ? error.message : String(error) },
            'restart attempt failed',
          );
        }
      })();
    }, wait);
    timer.unref?.();
    entry.restartTimer = timer;
  }

  #setState(entry: Entry, state: ComponentState): void {
    entry.status.state = state;
    entry.status.since = Date.now();
  }

  async #withTimeout(promise: Promise<void>, ms: number, name: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`"${name}" stop timed out after ${ms}ms`)), ms);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
