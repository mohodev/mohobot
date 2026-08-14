import { randomUUID } from 'node:crypto';

import type { Storage } from './types.js';

export type OutboxStatus = 'pending' | 'processing' | 'done' | 'failed';

export interface OutboxEvent<T = unknown> {
  eventId: string;
  type: string;
  payload: T;
  status: OutboxStatus;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  nextAttemptAt: number;
  workerId?: string;
  /** Fencing token unique to this lease. Required when releasing a claim. */
  claimToken?: string;
  claimExpiresAt?: number;
  lastError?: string;
}

export interface AppendOutboxEvent<T = unknown> {
  eventId: string;
  type: string;
  payload: T;
  /** Optional initial retry time; defaults to now. */
  nextAttemptAt?: number;
}

export interface ClaimOptions {
  limit?: number;
  leaseMs?: number;
  now?: number;
}

export interface ReleaseOptions {
  /** Token returned by claim(). A stale lease cannot release a newer claim. */
  claimToken: string;
  /** `done` permanently completes the event; otherwise it becomes retryable. */
  done?: boolean;
  error?: string;
  /** Optional delay before a failed event can be claimed again. */
  retryAfterMs?: number;
  now?: number;
}

/** Optional multi-process-safe primitive implemented by SQLite. */
export interface AtomicOutboxStorage {
  claimOutboxAtomic<T = unknown>(workerId: string, options: Required<ClaimOptions>): Promise<OutboxEvent<T>[]>;
  releaseOutboxAtomic(eventId: string, workerId: string, options: ReleaseOptions & { now: number }): Promise<OutboxEvent | undefined>;
  recoverExpiredOutboxAtomic(now: number): Promise<number>;
}

const PREFIX = 'outbox:';
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_LIMIT = 10;
const MAX_ERROR_LENGTH = 2_000;

function key(eventId: string): string {
  return `${PREFIX}${eventId}`;
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function normalizeEvent<T>(value: OutboxEvent<T>): OutboxEvent<T> {
  return {
    ...value,
    attempts: Math.max(0, Math.floor(value.attempts)),
    nextAttemptAt: Number.isFinite(value.nextAttemptAt) ? value.nextAttemptAt : value.updatedAt,
  };
}

function atomicStorage(storage: Storage): AtomicOutboxStorage | undefined {
  const candidate = storage as Storage & Partial<AtomicOutboxStorage>;
  return typeof candidate.claimOutboxAtomic === 'function'
    && typeof candidate.releaseOutboxAtomic === 'function'
    && typeof candidate.recoverExpiredOutboxAtomic === 'function'
    ? candidate as Storage & AtomicOutboxStorage
    : undefined;
}

/**
 * Storage-backed local outbox.
 *
 * Event IDs are the idempotency key. A claim is leased, so a crashed worker
 * does not permanently strand an event. Operations are serialized per
 * Outbox instance. The generic Storage fallback is safe only within one
 * process because its serialization queue is instance-local. SQLite provides
 * an atomic multi-process claim primitive without changing callers.
 */
export class Outbox {
  readonly #storage: Storage;
  #queue: Promise<void> = Promise.resolve();

  constructor(storage: Storage) {
    this.#storage = storage;
  }

  async append<T>(input: AppendOutboxEvent<T>): Promise<OutboxEvent<T>> {
    this.#assertEventId(input.eventId);
    if (!input.type.trim()) throw new Error('outbox event type is required');
    return this.#serial(async () => {
      const existing = await this.#storage.get<OutboxEvent<T>>(key(input.eventId));
      if (existing) return normalizeEvent(existing);
      const now = Date.now();
      const event: OutboxEvent<T> = {
        eventId: input.eventId,
        type: input.type,
        payload: input.payload,
        status: 'pending',
        attempts: 0,
        createdAt: now,
        updatedAt: now,
        nextAttemptAt: input.nextAttemptAt ?? now,
      };
      await this.#storage.save(key(event.eventId), event);
      return event;
    });
  }

  async get<T = unknown>(eventId: string): Promise<OutboxEvent<T> | undefined> {
    this.#assertEventId(eventId);
    const value = await this.#storage.get<OutboxEvent<T>>(key(eventId));
    return value ? normalizeEvent(value) : undefined;
  }

  async claim<T = unknown>(workerId: string, options: ClaimOptions = {}): Promise<OutboxEvent<T>[]> {
    if (!workerId.trim()) throw new Error('outbox workerId is required');
    const limit = positiveInt(options.limit, DEFAULT_LIMIT);
    const leaseMs = positiveInt(options.leaseMs, DEFAULT_LEASE_MS);
    const now = options.now ?? Date.now();
    const atomic = atomicStorage(this.#storage);
    if (atomic) return atomic.claimOutboxAtomic<T>(workerId, { limit, leaseMs, now });
    return this.#serial(async () => {
      await this.#recoverExpired(now);
      const rows = await this.#storage.query<OutboxEvent<T>>({ prefix: PREFIX });
      const candidates = rows
        .map((row) => normalizeEvent(row.value))
        .filter((event) => (event.status === 'pending' || event.status === 'failed') && event.nextAttemptAt <= now)
        .sort((a, b) => (a.createdAt - b.createdAt) || a.eventId.localeCompare(b.eventId))
        .slice(0, limit);
      const claimed: OutboxEvent<T>[] = [];
      for (const event of candidates) {
        const next: OutboxEvent<T> = {
          ...event,
          status: 'processing',
          attempts: event.attempts + 1,
          updatedAt: now,
          workerId,
          claimToken: randomUUID(),
          claimExpiresAt: now + leaseMs,
        };
        await this.#storage.save(key(event.eventId), next);
        claimed.push(next);
      }
      return claimed;
    });
  }

  async release(eventId: string, workerId: string, options: ReleaseOptions): Promise<OutboxEvent | undefined> {
    this.#assertEventId(eventId);
    if (!workerId.trim()) throw new Error('outbox workerId is required');
    if (!options.claimToken?.trim()) throw new Error('outbox claimToken is required');
    const now = options.now ?? Date.now();
    const atomic = atomicStorage(this.#storage);
    if (atomic) return atomic.releaseOutboxAtomic(eventId, workerId, { ...options, now });
    return this.#serial(async () => {
      const current = await this.get(eventId);
      if (!current) return undefined;
      if (current.status !== 'processing' || current.workerId !== workerId || current.claimToken !== options.claimToken) return current;
      const done = options.done === true;
      const next: OutboxEvent = {
        ...current,
        status: done ? 'done' : 'failed',
        updatedAt: now,
        nextAttemptAt: done ? now : now + Math.max(0, options.retryAfterMs ?? 0),
        ...(done ? { workerId: undefined, claimToken: undefined, claimExpiresAt: undefined, lastError: undefined } : {
          workerId: undefined,
          claimToken: undefined,
          claimExpiresAt: undefined,
          ...(options.error ? { lastError: options.error.slice(0, MAX_ERROR_LENGTH) } : {}),
        }),
      };
      await this.#storage.save(key(eventId), next);
      return next;
    });
  }

  async recoverExpired(now = Date.now()): Promise<number> {
    const atomic = atomicStorage(this.#storage);
    if (atomic) return atomic.recoverExpiredOutboxAtomic(now);
    return this.#serial(() => this.#recoverExpired(now));
  }

  async list<T = unknown>(status?: OutboxStatus): Promise<OutboxEvent<T>[]> {
    const rows = await this.#storage.query<OutboxEvent<T>>({ prefix: PREFIX });
    return rows.map((row) => normalizeEvent(row.value)).filter((event) => !status || event.status === status);
  }

  async #recoverExpired(now: number): Promise<number> {
    const rows = await this.#storage.query<OutboxEvent>({ prefix: PREFIX });
    let recovered = 0;
    for (const row of rows) {
      const event = normalizeEvent(row.value);
      if (event.status !== 'processing' || event.claimExpiresAt === undefined || event.claimExpiresAt > now) continue;
      await this.#storage.save(key(event.eventId), {
        ...event,
        status: 'pending',
        updatedAt: now,
        nextAttemptAt: now,
        workerId: undefined,
        claimToken: undefined,
        claimExpiresAt: undefined,
      });
      recovered += 1;
    }
    return recovered;
  }

  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(operation);
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }

  #assertEventId(eventId: string): void {
    if (!eventId.trim()) throw new Error('outbox eventId is required');
  }
}
