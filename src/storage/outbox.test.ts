import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStorage } from './memory.js';
import { Outbox } from './outbox.js';
import { createNullLogger } from '../core/logger.js';

let storage: MemoryStorage | undefined;
async function makeOutbox(): Promise<Outbox> {
  storage = new MemoryStorage({ logger: createNullLogger() });
  await storage.init();
  return new Outbox(storage);
}
afterEach(async () => { await storage?.close(); storage = undefined; });

describe('Outbox', () => {
  it('appends idempotently by eventId and keeps the first payload', async () => {
    const outbox = await makeOutbox();
    const first = await outbox.append({ eventId: 'event-1', type: 'memory.updated', payload: { value: 1 } });
    const duplicate = await outbox.append({ eventId: 'event-1', type: 'other', payload: { value: 2 } });
    expect(duplicate).toEqual(first);
    expect((await outbox.list()).map((event) => event.eventId)).toEqual(['event-1']);
  });

  it('claims pending events in creation order, increments attempts, and enforces ownership', async () => {
    const outbox = await makeOutbox();
    await outbox.append({ eventId: 'a', type: 'test', payload: 1, nextAttemptAt: 10 });
    await outbox.append({ eventId: 'b', type: 'test', payload: 2, nextAttemptAt: 10 });
    const claimed = await outbox.claim('worker-a', { limit: 1, now: 10, leaseMs: 100 });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ eventId: 'a', status: 'processing', attempts: 1, workerId: 'worker-a', claimExpiresAt: 110 });
    const token = claimed[0]!.claimToken!;
    expect(await outbox.release('a', 'worker-b', { claimToken: token, done: true, now: 20 })).toMatchObject({ status: 'processing', workerId: 'worker-a' });
    expect(await outbox.release('a', 'worker-a', { claimToken: 'stale-token', done: true, now: 25 })).toMatchObject({ status: 'processing', workerId: 'worker-a' });
    expect(await outbox.release('a', 'worker-a', { claimToken: token, done: true, now: 30 })).toMatchObject({ status: 'done', attempts: 1 });
    expect((await outbox.claim('worker-a', { now: 30 }))[0]?.eventId).toBe('b');
  });

  it('releases failures with retry delay and preserves a bounded error', async () => {
    const outbox = await makeOutbox();
    await outbox.append({ eventId: 'retry', type: 'test', payload: {}, nextAttemptAt: 0 });
    const [claim] = await outbox.claim('worker', { now: 100, leaseMs: 50 });
    const failed = await outbox.release('retry', 'worker', { claimToken: claim!.claimToken!, error: 'x'.repeat(3000), retryAfterMs: 100, now: 110 });
    expect(failed).toMatchObject({ status: 'failed', attempts: 1, nextAttemptAt: 210 });
    expect(failed?.lastError).toHaveLength(2000);
    expect(await outbox.claim('worker', { now: 209 })).toEqual([]);
    expect((await outbox.claim('worker', { now: 210 }))[0]?.attempts).toBe(2);
  });

  it('recovers expired claims and makes them claimable by another worker', async () => {
    const outbox = await makeOutbox();
    await outbox.append({ eventId: 'stuck', type: 'test', payload: {}, nextAttemptAt: 1_000 });
    await outbox.claim('dead-worker', { now: 1_000, leaseMs: 50 });
    expect(await outbox.recoverExpired(1_050)).toBe(1);
    const claimed = await outbox.claim('new-worker', { now: 1_051, leaseMs: 50 });
    expect(claimed[0]).toMatchObject({ eventId: 'stuck', status: 'processing', attempts: 2, workerId: 'new-worker' });
  });

  it('does not claim future events or completed events', async () => {
    const outbox = await makeOutbox();
    await outbox.append({ eventId: 'future', type: 'test', payload: {}, nextAttemptAt: 100 });
    await outbox.append({ eventId: 'done', type: 'test', payload: {}, nextAttemptAt: 0 });
    const [doneClaim] = await outbox.claim('worker', { now: 0 });
    await outbox.release('done', 'worker', { claimToken: doneClaim!.claimToken!, done: true, now: 1 });
    expect((await outbox.claim('worker', { now: 99 })).map((event) => event.eventId)).toEqual([]);
    expect((await outbox.claim('worker', { now: 100 })).map((event) => event.eventId)).toEqual(['future']);
  });
});
