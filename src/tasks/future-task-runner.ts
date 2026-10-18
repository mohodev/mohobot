/**
 * Poll-based runner for future tasks.
 *
 * Periodically polls the FutureTaskStore for pending work, claims tasks
 * atomically, dispatches them to registered handlers, and marks them
 * complete or failed. Supports configurable concurrency, poll interval,
 * lease timeout, and graceful shutdown with in-flight drain.
 */

import { randomUUID } from 'node:crypto';
import type { Logger } from '../core/logger.js';
import { FutureTaskStore, type FutureTask } from './future-task.js';

export type FutureTaskHandler = (task: FutureTask, signal: AbortSignal) => Promise<unknown>;

export interface FutureTaskRunnerOptions {
  store: FutureTaskStore;
  logger: Logger;
  /** Unique identity for this worker. Defaults to a random UUID. */
  workerId?: string;
  /** How often to poll for pending tasks (ms). Default 5000. */
  pollIntervalMs?: number;
  /** Maximum tasks to execute concurrently. Default 4. */
  concurrency?: number;
  /** After this many ms a claimed task is considered stale. Default 60000. */
  leaseTimeoutMs?: number;
  /** How often to run lease recovery (ms). Default 30000. */
  recoveryIntervalMs?: number;
}

export class FutureTaskRunner {
  readonly #store: FutureTaskStore;
  readonly #log: Logger;
  readonly #workerId: string;
  readonly #pollMs: number;
  readonly #concurrency: number;
  readonly #leaseTimeoutMs: number;
  readonly #recoveryMs: number;
  readonly #handlers = new Map<string, FutureTaskHandler>();
  readonly #inflight = new Set<Promise<void>>();
  #pollTimer?: NodeJS.Timeout;
  #recoveryTimer?: NodeJS.Timeout;
  #stopped = false;
  #controller = new AbortController();

  constructor(opts: FutureTaskRunnerOptions) {
    this.#store = opts.store;
    this.#log = opts.logger.child({ component: 'future-task-runner' });
    this.#workerId = opts.workerId ?? randomUUID();
    this.#pollMs = opts.pollIntervalMs ?? 5_000;
    this.#concurrency = opts.concurrency ?? 4;
    this.#leaseTimeoutMs = opts.leaseTimeoutMs ?? 60_000;
    this.#recoveryMs = opts.recoveryIntervalMs ?? 30_000;
  }

  get workerId(): string { return this.#workerId; }
  get inflightCount(): number { return this.#inflight.size; }

  register(type: string, handler: FutureTaskHandler): void {
    if (this.#handlers.has(type)) throw new Error(`handler already registered for type: ${type}`);
    this.#handlers.set(type, handler);
  }

  start(): void {
    if (this.#pollTimer) return;
    this.#stopped = false;
    this.#controller = new AbortController();
    this.#pollTimer = setInterval(() => void this.#poll(), this.#pollMs);
    this.#pollTimer.unref?.();
    this.#recoveryTimer = setInterval(() => void this.#recover(), this.#recoveryMs);
    this.#recoveryTimer.unref?.();
    this.#log.info({ workerId: this.#workerId, pollMs: this.#pollMs, concurrency: this.#concurrency }, 'future task runner started');
  }

  async stop(graceMs = 5000): Promise<void> {
    this.#stopped = true;
    if (this.#pollTimer) { clearInterval(this.#pollTimer); this.#pollTimer = undefined; }
    if (this.#recoveryTimer) { clearInterval(this.#recoveryTimer); this.#recoveryTimer = undefined; }
    this.#controller.abort();
    if (this.#inflight.size > 0) {
      this.#log.info({ inflight: this.#inflight.size }, 'draining in-flight tasks');
      await Promise.race([
        Promise.allSettled([...this.#inflight]),
        new Promise<void>(resolve => { const t = setTimeout(resolve, graceMs); t.unref?.(); }),
      ]);
    }
    this.#log.info({}, 'future task runner stopped');
  }

  async #poll(): Promise<void> {
    if (this.#stopped) return;
    try {
      const available = this.#concurrency - this.#inflight.size;
      if (available <= 0) return;
      const tasks = await this.#store.pending(available);
      for (const task of tasks) {
        if (this.#stopped) break;
        if (this.#inflight.size >= this.#concurrency) break;
        if (!this.#handlers.has(task.type)) {
          this.#log.warn({ taskId: task.id, type: task.type }, 'no handler registered for task type');
          continue;
        }
        const claimed = await this.#store.claim(task.id, this.#workerId);
        if (!claimed) continue;
        const promise = this.#execute(claimed);
        this.#inflight.add(promise);
        void promise.finally(() => this.#inflight.delete(promise));
      }
    } catch (error) {
      this.#log.error({ err: error instanceof Error ? error.message : String(error) }, 'poll cycle failed');
    }
  }

  async #execute(task: FutureTask): Promise<void> {
    const handler = this.#handlers.get(task.type);
    if (!handler) return;
    const started = Date.now();
    try {
      const timeoutMs = task.timeoutMs || this.#leaseTimeoutMs;
      const result = await this.#withTimeout(
        handler(task, this.#controller.signal),
        timeoutMs,
        task.id,
      );
      await this.#store.complete(task.id, result);
      this.#log.debug({ taskId: task.id, type: task.type, durationMs: Date.now() - started }, 'task completed');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        if (message.includes('timed out') || this.#controller.signal.aborted) await this.#store.uncertain(task.id, message);
        else await this.#store.fail(task.id, message);
      } catch (failError) {
        this.#log.error({ taskId: task.id, err: failError instanceof Error ? failError.message : String(failError) }, 'failed to record task failure');
      }
      this.#log.warn({ taskId: task.id, type: task.type, err: message, durationMs: Date.now() - started }, 'task failed');
    }
  }

  async #recover(): Promise<void> {
    if (this.#stopped) return;
    try {
      const recovered = await this.#store.recover(this.#leaseTimeoutMs);
      if (recovered.length > 0) {
        this.#log.info({ count: recovered.length }, 'recovered stale tasks');
      }
    } catch (error) {
      this.#log.error({ err: error instanceof Error ? error.message : String(error) }, 'recovery cycle failed');
    }
  }

  async #withTimeout(promise: Promise<unknown>, timeoutMs: number, taskId: string): Promise<unknown> {
    if (timeoutMs <= 0) return promise;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`task "${taskId}" timed out after ${timeoutMs}ms`)), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
