/**
 * SQLite-persisted future task scheduler.
 *
 * Tasks are stored via the generic Storage KV interface with a `future-task:`
 * key prefix. Atomic claim uses compare-and-swap semantics (read-check-write
 * under the assumption that Storage saves are serialised per key). Lease
 * recovery reclaims tasks that were claimed but never completed within the
 * configured timeout.
 *
 * Task payloads must never contain secrets; they are persisted in plaintext and
 * exposed through the admin API.
 */

import { randomUUID } from 'node:crypto';
import type { Storage, StoredRecord } from '../storage/types.js';

/* ------------------------------------------------------------------ types */

export type FutureTaskStatus = 'pending' | 'claimed' | 'completed' | 'failed' | 'expired' | 'uncertain';

export interface FutureTask {
  kind: 'future-task';
  recordVersion: 1;
  id: string;
  type: string;
  payload: Record<string, unknown>;
  scheduledAt: number;
  createdAt: number;
  claimedBy?: string;
  claimedAt?: number;
  completedAt?: number;
  status: FutureTaskStatus;
  retryCount: number;
  maxRetries: number;
  timeoutMs: number;
  owner: string;
  result?: unknown;
  error?: string;
}

export interface ScheduleInput {
  id?: string;
  type: string;
  payload: Record<string, unknown>;
  scheduledAt?: number;
  maxRetries?: number;
  timeoutMs?: number;
  owner: string;
}

export interface FutureTaskFilter {
  status?: FutureTaskStatus;
  owner?: string;
  type?: string;
  limit?: number;
  offset?: number;
}

/* ------------------------------------------------------------------ helpers */

const PREFIX = 'future-task:';
const RECORD_VERSION = 1;

function taskKey(id: string): string { return `${PREFIX}${id}`; }

function validId(x: unknown): x is string {
  return typeof x === 'string' && /^[a-zA-Z0-9_-]{1,96}$/.test(x);
}

function assertId(x: string, label = 'id'): void {
  if (!validId(x)) throw new Error(`invalid ${label}`);
}

function envelope(value: unknown): FutureTask | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Partial<FutureTask>;
  if (v.kind !== 'future-task' || v.recordVersion !== RECORD_VERSION) return undefined;
  return value as FutureTask;
}

/* ------------------------------------------------------------------ store */

export class FutureTaskStore {
  constructor(private readonly storage: Storage) {}

  async schedule(input: ScheduleInput): Promise<FutureTask> {
    const id = input.id ?? randomUUID();
    assertId(id, 'task id');
    if (!/^[a-z][a-z0-9._-]{0,119}$/.test(input.type)) throw new Error('invalid task type');
    if (!input.owner || input.owner.length > 120) throw new Error('invalid owner');
    if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) throw new Error('payload must be an object');
    if (input.scheduledAt !== undefined && (!Number.isFinite(input.scheduledAt) || input.scheduledAt < 0)) throw new Error('invalid scheduledAt');
    if (input.maxRetries !== undefined && (!Number.isInteger(input.maxRetries) || input.maxRetries < 0 || input.maxRetries > 20)) throw new Error('invalid maxRetries');
    if (input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1_000 || input.timeoutMs > 300_000)) throw new Error('invalid timeoutMs');

    const currentValue = await this.storage.get<unknown>(taskKey(id));
    if (currentValue !== undefined) throw new Error('task already exists');

    const now = Date.now();
    const task: FutureTask = {
      kind: 'future-task',
      recordVersion: RECORD_VERSION,
      id,
      type: input.type,
      payload: input.payload ?? {},
      scheduledAt: input.scheduledAt ?? now,
      createdAt: now,
      status: 'pending',
      retryCount: 0,
      maxRetries: input.maxRetries ?? 3,
      timeoutMs: input.timeoutMs ?? 30_000,
      owner: input.owner,
    };
    if (this.storage.compareAndSet) {
      if (!await this.storage.compareAndSet(taskKey(id), undefined, task)) throw new Error('task already exists');
    } else await this.storage.save(taskKey(id), task);
    return task;
  }

  async claim(taskId: string, workerId: string): Promise<FutureTask | undefined> {
    assertId(taskId, 'task id');
    const task = envelope(await this.storage.get(taskKey(taskId)));
    if (!task || task.status !== 'pending') return undefined;
    if (task.scheduledAt > Date.now()) return undefined;

    task.status = 'claimed';
    task.claimedBy = workerId;
    task.claimedAt = Date.now();
    if (this.storage.compareAndSet) {
      const current = await this.storage.get<unknown>(taskKey(taskId));
      const expected = envelope(current);
      if (!expected || expected.status !== 'pending') return undefined;
      if (!await this.storage.compareAndSet(taskKey(taskId), expected, task)) return undefined;
    } else await this.storage.save(taskKey(taskId), task);
    return task;
  }

  async complete(taskId: string, result?: unknown): Promise<FutureTask> {
    assertId(taskId, 'task id');
    const task = envelope(await this.storage.get(taskKey(taskId)));
    if (!task) throw new Error('task not found');
    if (task.status !== 'claimed') throw new Error('task not claimed');

    task.status = 'completed';
    task.completedAt = Date.now();
    task.result = result;
    await this.storage.save(taskKey(taskId), task);
    return task;
  }

  async fail(taskId: string, error: string): Promise<FutureTask> {
    assertId(taskId, 'task id');
    const task = envelope(await this.storage.get(taskKey(taskId)));
    if (!task) throw new Error('task not found');
    if (task.status !== 'claimed') throw new Error('task not claimed');

    task.retryCount += 1;
    task.error = error;
    if (task.retryCount <= task.maxRetries) {
      task.status = 'pending';
      task.claimedBy = undefined;
      task.claimedAt = undefined;
    } else {
      task.status = 'failed';
      task.completedAt = Date.now();
    }
    await this.storage.save(taskKey(taskId), task);
    return task;
  }

  async expire(taskId: string): Promise<FutureTask> {
    assertId(taskId, 'task id');
    const task = envelope(await this.storage.get(taskKey(taskId)));
    if (!task) throw new Error('task not found');

    task.status = 'expired';
    task.completedAt = Date.now();
    await this.storage.save(taskKey(taskId), task);
    return task;
  }

  async uncertain(taskId:string,error:string):Promise<FutureTask>{
    assertId(taskId,'task id');const task=envelope(await this.storage.get(taskKey(taskId)));
    if(!task)throw new Error('task not found');if(task.status!=='claimed')throw new Error('task not claimed');
    task.status='uncertain';task.error=error;task.completedAt=Date.now();await this.storage.save(taskKey(taskId),task);return task;
  }

  async recover(staleMs: number): Promise<FutureTask[]> {
    const now = Date.now();
    const rows = await this.storage.query<unknown>({ prefix: PREFIX, limit: 10_000 });
    const recovered: FutureTask[] = [];
    for (const row of rows) {
      const task = envelope(row.value);
      if (!task) continue;
      if (task.status !== 'claimed') continue;
      if (!task.claimedAt || (now - task.claimedAt) < staleMs) continue;

      task.retryCount += 1;
      if (task.retryCount <= task.maxRetries) {
        task.status = 'pending';
        task.claimedBy = undefined;
        task.claimedAt = undefined;
      } else {
        task.status = 'failed';
        task.completedAt = now;
        task.error = 'lease expired after max retries';
      }
      await this.storage.save(taskKey(task.id), task);
      recovered.push(task);
    }
    return recovered;
  }

  async get(taskId: string): Promise<FutureTask | undefined> {
    assertId(taskId, 'task id');
    return envelope(await this.storage.get(taskKey(taskId)));
  }

  async list(filter?: FutureTaskFilter): Promise<FutureTask[]> {
    const rows = await this.storage.query<unknown>({ prefix: PREFIX, limit: 10_000 });
    let tasks = rows
      .map((r: StoredRecord<unknown>) => envelope(r.value))
      .filter((t): t is FutureTask => Boolean(t));

    if (filter?.status) tasks = tasks.filter(t => t.status === filter.status);
    if (filter?.owner) tasks = tasks.filter(t => t.owner === filter.owner);
    if (filter?.type) tasks = tasks.filter(t => t.type === filter.type);

    tasks.sort((a, b) => a.scheduledAt - b.scheduledAt);

    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? 200;
    return tasks.slice(offset, offset + limit);
  }

  async pending(limit = 50): Promise<FutureTask[]> {
    const now = Date.now();
    const rows = await this.storage.query<unknown>({ prefix: PREFIX, limit: 10_000 });
    return rows
      .map((r: StoredRecord<unknown>) => envelope(r.value))
      .filter((t): t is FutureTask => t !== undefined && t.status === 'pending' && t.scheduledAt <= now)
      .sort((a, b) => a.scheduledAt - b.scheduledAt)
      .slice(0, limit);
  }
}
