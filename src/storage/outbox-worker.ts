import { randomUUID } from 'node:crypto';
import type { Logger } from '../core/logger.js';
import { Outbox, type OutboxEvent } from './outbox.js';
import { runtimeMetrics } from '../core/runtime-metrics.js';

export interface RemoteMirror {
  /** Deliver one event. Implementations must use eventId as an idempotency key. */
  send(event: OutboxEvent): Promise<void>;
}

export interface OutboxWorkerOptions {
  workerId?: string;
  pollIntervalMs?: number;
  batchSize?: number;
  concurrency?: number;
  leaseMs?: number;
  retryDelayMs?: number | ((event: OutboxEvent, error: unknown) => number);
}

export interface OutboxWorkerStats {
  claimed: number;
  sent: number;
  failed: number;
  polls: number;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 5_000;

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * Polls the local Outbox and mirrors claimed events to an optional remote sink.
 * It owns no database driver: MySQL, HTTP, Kafka, or test mirrors implement the
 * small RemoteMirror interface and preserve eventId idempotency remotely.
 */
export class OutboxWorker {
  readonly #outbox: Outbox;
  readonly #mirror: RemoteMirror;
  readonly #logger: Logger;
  readonly #workerId: string;
  readonly #pollIntervalMs: number;
  readonly #batchSize: number;
  readonly #concurrency: number;
  readonly #leaseMs: number;
  readonly #retryDelay: NonNullable<OutboxWorkerOptions['retryDelayMs']>;
  readonly #stats: OutboxWorkerStats = { claimed: 0, sent: 0, failed: 0, polls: 0 };
  #timer?: NodeJS.Timeout;
  #running = false;
  #stopping = false;
  #inflight?: Promise<number>;

  constructor(outbox: Outbox, mirror: RemoteMirror, logger: Logger, options: OutboxWorkerOptions = {}) {
    this.#outbox = outbox;
    this.#mirror = mirror;
    this.#logger = logger.child({ component: 'outbox-worker' });
    this.#workerId = options.workerId?.trim() || `mirror-${randomUUID()}`;
    this.#pollIntervalMs = positiveInt(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
    this.#batchSize = positiveInt(options.batchSize, DEFAULT_BATCH_SIZE);
    this.#concurrency = Math.min(this.#batchSize, positiveInt(options.concurrency, DEFAULT_CONCURRENCY));
    this.#leaseMs = positiveInt(options.leaseMs, DEFAULT_LEASE_MS);
    this.#retryDelay = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  }

  get workerId(): string { return this.#workerId; }
  get running(): boolean { return this.#running; }
  stats(): OutboxWorkerStats { return { ...this.#stats }; }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#stopping = false;
    this.#schedule(0);
  }

  /** Drain all events that are currently eligible for claiming. */
  async flush(): Promise<number> {
    if (this.#stopping) return 0;
    let total = 0;
    while (!this.#stopping) {
      const processed = await this.#pollOnce();
      total += processed;
      if (processed < this.#batchSize) break;
    }
    return total;
  }

  /** Stop new claims and wait for the active batch to settle. */
  async stop(): Promise<void> {
    this.#stopping = true;
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#inflight?.catch(() => {});
    this.#stopping = false;
  }

  #schedule(delayMs: number): void {
    if (!this.#running || this.#stopping) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (!this.#running || this.#stopping) return;
      this.#inflight = this.#pollOnce();
      void this.#inflight.finally(() => {
        this.#inflight = undefined;
        this.#schedule(this.#pollIntervalMs);
      });
    }, delayMs);
    this.#timer.unref?.();
  }

  async #pollOnce(): Promise<number> {
    if (this.#stopping) return 0;
    this.#stats.polls += 1;
    const events = await this.#outbox.claim(this.#workerId, {
      limit: this.#batchSize,
      leaseMs: this.#leaseMs,
    });
    this.#stats.claimed += events.length;
    if (events.length === 0) return 0;

    let cursor = 0;
    const runners = Array.from({ length: Math.min(this.#concurrency, events.length) }, async () => {
      // Once claimed, finish the batch even if stop() was requested. Leaving
      // claimed rows untouched would strand them until their lease expires.
      while (true) {
        const index = cursor;
        cursor += 1;
        const event = events[index];
        if (!event) return;
        await this.#deliver(event);
      }
    });
    await Promise.all(runners);
    return events.length;
  }

  async #deliver(event: OutboxEvent): Promise<void> {
    const started=Date.now();
    try {
      await this.#mirror.send(event);
      await this.#outbox.release(event.eventId, this.#workerId, { done: true });
      this.#stats.sent += 1;
      runtimeMetrics.outbox.record(Date.now()-started,true);
    } catch (error) {
      runtimeMetrics.outbox.record(Date.now()-started,false);
      const retryAfterMs = Math.max(0, typeof this.#retryDelay === 'function'
        ? this.#retryDelay(event, error)
        : this.#retryDelay);
      await this.#outbox.release(event.eventId, this.#workerId, {
        error: error instanceof Error ? error.message : String(error),
        retryAfterMs,
      });
      this.#stats.failed += 1;
      this.#logger.warn({ eventId: event.eventId, type: event.type, retryAfterMs, err: error }, 'remote mirror send failed');
    }
  }
}
