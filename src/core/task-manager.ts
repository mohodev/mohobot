/**
 * TaskManager - the ONLY sanctioned way to create background work.
 *
 * Business code must never call setInterval/setTimeout or float a bare promise:
 * an unowned task that throws becomes an unhandled rejection, and an unowned
 * interval keeps a dying process alive. Everything here is tracked, isolated,
 * and stoppable.
 */

import { randomUUID } from 'node:crypto';
import type { EventBus } from './event.js';
import type { Logger } from './logger.js';

export type TaskState = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
export type TaskKind = 'oneshot' | 'interval';

export interface TaskInfo {
  id: string;
  name: string;
  kind: TaskKind;
  state: TaskState;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  runs: number;
  errors: number;
  lastError?: string;
  lastRunMs?: number;
}

export interface TaskContext {
  /** Aborted when the task or the manager is stopped. */
  signal: AbortSignal;
  taskId: string;
  name: string;
}

export type TaskFn = (ctx: TaskContext) => unknown | Promise<unknown>;

export interface SpawnOptions {
  name: string;
  /** Repeat every N ms. Omit for a one-shot task. */
  intervalMs?: number;
  /** For interval tasks: run once immediately instead of waiting a full period. */
  immediate?: boolean;
  /** Kill a single run that exceeds this many ms. */
  timeoutMs?: number;
  /** Keep an interval task going after a failed run. Default true. */
  continueOnError?: boolean;
}

interface TaskEntry {
  info: TaskInfo;
  controller: AbortController;
  timer?: NodeJS.Timeout;
  inflight?: Promise<void>;
}

export class TaskManager {
  readonly #tasks = new Map<string, TaskEntry>();
  readonly #logger: Logger;
  readonly #events?: EventBus;
  #stopped = false;

  constructor(deps: { logger: Logger; events?: EventBus }) {
    this.#logger = deps.logger.child({ component: 'tasks' });
    this.#events = deps.events;
  }

  /**
   * Register and start a task. Returns its id.
   * A task that throws is logged and counted - it never escapes.
   */
  spawn(fn: TaskFn, options: SpawnOptions): string {
    if (this.#stopped) {
      this.#logger.warn({ name: options.name }, 'task rejected: manager stopped');
      return '';
    }
    const id = randomUUID();
    const controller = new AbortController();
    const entry: TaskEntry = {
      info: {
        id,
        name: options.name,
        kind: options.intervalMs ? 'interval' : 'oneshot',
        state: 'pending',
        createdAt: Date.now(),
        runs: 0,
        errors: 0,
      },
      controller,
    };
    this.#tasks.set(id, entry);

    const runOnce = async (): Promise<void> => {
      if (entry.controller.signal.aborted) return;
      const started = Date.now();
      entry.info.state = 'running';
      entry.info.startedAt = started;
      entry.info.runs += 1;
      this.#events?.emit('task:start', { taskId: id, name: options.name });
      try {
        await this.#withTimeout(
          Promise.resolve(fn({ signal: entry.controller.signal, taskId: id, name: options.name })),
          options.timeoutMs,
          options.name,
        );
        entry.info.lastRunMs = Date.now() - started;
        entry.info.state = entry.info.kind === 'interval' ? 'pending' : 'done';
        if (entry.info.kind === 'oneshot') entry.info.finishedAt = Date.now();
        this.#events?.emit('task:done', { taskId: id, name: options.name, ms: entry.info.lastRunMs });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        entry.info.errors += 1;
        entry.info.lastError = msg;
        entry.info.lastRunMs = Date.now() - started;
        entry.info.state = entry.info.kind === 'interval' ? 'pending' : 'failed';
        this.#logger.error({ task: options.name, taskId: id, err: msg }, 'task failed');
        this.#events?.emit('task:error', { taskId: id, name: options.name, error: msg });
        if (entry.info.kind === 'interval' && options.continueOnError === false) {
          this.cancel(id);
        }
      }
    };

    if (options.intervalMs && options.intervalMs > 0) {
      const timer = setInterval(() => {
        // Skip a tick if the previous run is still going - no pile-up.
        if (entry.inflight) return;
        entry.inflight = runOnce().finally(() => {
          entry.inflight = undefined;
        });
      }, options.intervalMs);
      // Do not hold the event loop open on our account.
      timer.unref?.();
      entry.timer = timer;
      if (options.immediate) {
        entry.inflight = runOnce().finally(() => {
          entry.inflight = undefined;
        });
      }
    } else {
      entry.inflight = runOnce().finally(() => {
        entry.inflight = undefined;
      });
    }

    return id;
  }

  /** Convenience wrapper: run a promise under task tracking. */
  run<T>(name: string, fn: (ctx: TaskContext) => Promise<T>, timeoutMs?: number): string {
    return this.spawn(fn as TaskFn, timeoutMs === undefined ? { name } : { name, timeoutMs });
  }

  cancel(id: string): boolean {
    const entry = this.#tasks.get(id);
    if (!entry) return false;
    entry.controller.abort();
    if (entry.timer) clearInterval(entry.timer);
    entry.info.state = 'cancelled';
    entry.info.finishedAt = Date.now();
    this.#tasks.delete(id);
    return true;
  }

  cancelByName(name: string): number {
    let n = 0;
    for (const [id, entry] of [...this.#tasks]) {
      if (entry.info.name === name && this.cancel(id)) n += 1;
    }
    return n;
  }

  list(): TaskInfo[] {
    return [...this.#tasks.values()].map((e) => ({ ...e.info }));
  }

  get size(): number {
    return this.#tasks.size;
  }

  /** Cancel everything and wait (bounded) for in-flight runs to settle. */
  async stopAll(graceMs = 5000): Promise<void> {
    this.#stopped = true;
    const inflight: Promise<void>[] = [];
    for (const [id, entry] of [...this.#tasks]) {
      if (entry.inflight) inflight.push(entry.inflight);
      this.cancel(id);
    }
    if (inflight.length === 0) return;
    await Promise.race([
      Promise.allSettled(inflight),
      new Promise<void>((resolve) => setTimeout(resolve, graceMs).unref?.()),
    ]);
  }

  async #withTimeout(promise: Promise<unknown>, timeoutMs: number | undefined, name: string): Promise<void> {
    if (!timeoutMs || timeoutMs <= 0) {
      await promise;
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`task "${name}" timed out after ${timeoutMs}ms`)), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
