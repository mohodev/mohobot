import { describe, expect, it, vi } from 'vitest';
import { MemoryStorage } from '../storage/memory.js';
import { createNullLogger } from '../core/logger.js';
import { FutureTaskStore } from './future-task.js';
import type { Storage } from '../storage/types.js';

function store() {
  const s = new MemoryStorage({ logger: createNullLogger() });
  return { storage: s, tasks: new FutureTaskStore(s) };
}

describe('FutureTaskStore', () => {
  it('schedules and retrieves a task', async () => {
    const { storage, tasks } = store();
    await storage.init();
    const task = await tasks.schedule({ type: 'test', payload: { x: 1 }, owner: 'bot-1' });
    expect(task.id).toBeTruthy();
    expect(task.status).toBe('pending');
    expect(task.retryCount).toBe(0);
    expect(task.owner).toBe('bot-1');
    const got = await tasks.get(task.id);
    expect(got).toBeDefined();
    expect(got!.type).toBe('test');
  });

  it('rejects duplicate task ids', async () => {
    const { storage, tasks } = store();
    await storage.init();
    await tasks.schedule({ id: 'dup-1', type: 'test', payload: {}, owner: 'bot-1' });
    await expect(tasks.schedule({ id: 'dup-1', type: 'test', payload: {}, owner: 'bot-1' })).rejects.toThrow('task already exists');
  });

  it('claim transitions pending to claimed', async () => {
    const { storage, tasks } = store();
    await storage.init();
    const task = await tasks.schedule({ type: 'test', payload: {}, owner: 'bot-1' });
    const claimed = await tasks.claim(task.id, 'worker-1');
    expect(claimed).toBeDefined();
    expect(claimed!.status).toBe('claimed');
    expect(claimed!.claimedBy).toBe('worker-1');
    expect(claimed!.claimedAt).toBeGreaterThan(0);
  });

  it('claim returns undefined for non-pending tasks', async () => {
    const { storage, tasks } = store();
    await storage.init();
    const task = await tasks.schedule({ type: 'test', payload: {}, owner: 'bot-1' });
    await tasks.claim(task.id, 'worker-1');
    const second = await tasks.claim(task.id, 'worker-2');
    expect(second).toBeUndefined();
  });

  it('permits only one concurrent claim', async () => {
    const { storage, tasks } = store();
    await storage.init();
    const task = await tasks.schedule({ type: 'test', payload: {}, owner: 'bot-1' });
    const claims = await Promise.all([tasks.claim(task.id, 'worker-a'), tasks.claim(task.id, 'worker-b')]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it('uses the exact pending snapshot as its compare-and-set expectation', async () => {
    const { storage, tasks } = store();
    await storage.init();
    const task = await tasks.schedule({ type: 'test', payload: {}, owner: 'bot-1' });
    const original = storage.compareAndSet!.bind(storage);
    let calls = 0;
    storage.compareAndSet = async <T>(key: string, expected: T | undefined, value: T) => {
      calls += 1;
      if (calls === 1) {
        const current = await storage.get<any>(key);
        await original(key, current, { ...current, retryCount: 1 });
      }
      return original(key, expected, value);
    };
    expect(await tasks.claim(task.id, 'worker')).toBeUndefined();
    expect((await tasks.get(task.id))?.retryCount).toBe(1);
  });

  it('does not claim future-scheduled tasks', async () => {
    const { storage, tasks } = store();
    await storage.init();
    const task = await tasks.schedule({
      type: 'test',
      payload: {},
      owner: 'bot-1',
      scheduledAt: Date.now() + 60_000,
    });
    const claimed = await tasks.claim(task.id, 'worker-1');
    expect(claimed).toBeUndefined();
  });

  it('complete marks a claimed task as completed', async () => {
    const { storage, tasks } = store();
    await storage.init();
    const task = await tasks.schedule({ type: 'test', payload: {}, owner: 'bot-1' });
    await tasks.claim(task.id, 'worker-1');
    const done = await tasks.complete(task.id, { output: 'ok' });
    expect(done.status).toBe('completed');
    expect(done.result).toEqual({ output: 'ok' });
    expect(done.completedAt).toBeGreaterThan(0);
  });

  it('complete rejects unclaimed tasks', async () => {
    const { storage, tasks } = store();
    await storage.init();
    const task = await tasks.schedule({ type: 'test', payload: {}, owner: 'bot-1' });
    await expect(tasks.complete(task.id)).rejects.toThrow('task not claimed');
  });

  it('fail retries when retryCount < maxRetries', async () => {
    const { storage, tasks } = store();
    await storage.init();
    const task = await tasks.schedule({ type: 'test', payload: {}, owner: 'bot-1', maxRetries: 3 });
    await tasks.claim(task.id, 'w1');
    const failed = await tasks.fail(task.id, 'boom');
    expect(failed.status).toBe('pending');
    expect(failed.retryCount).toBe(1);
    expect(failed.claimedBy).toBeUndefined();
  });

  it('allows the configured retry count before failing permanently', async () => {
    const { storage, tasks } = store();
    await storage.init();
    const task = await tasks.schedule({ type: 'test', payload: {}, owner: 'bot-1', maxRetries: 1 });
    await tasks.claim(task.id, 'w1');
    const failed = await tasks.fail(task.id, 'boom');
    expect(failed.status).toBe('pending');
    expect(failed.retryCount).toBe(1);
    await tasks.claim(task.id, 'w1');
    const exhausted = await tasks.fail(task.id, 'boom again');
    expect(exhausted.status).toBe('failed');
    expect(exhausted.retryCount).toBe(2);
    expect(exhausted.completedAt).toBeGreaterThan(0);
  });

  it('expire marks task as expired', async () => {
    const { storage, tasks } = store();
    await storage.init();
    const task = await tasks.schedule({ type: 'test', payload: {}, owner: 'bot-1' });
    const expired = await tasks.expire(task.id);
    expect(expired.status).toBe('expired');
    expect(expired.completedAt).toBeGreaterThan(0);
  });

  it('recover reclaims stale claimed tasks', async () => {
    const { storage, tasks } = store();
    await storage.init();
    const task = await tasks.schedule({ type: 'test', payload: {}, owner: 'bot-1', maxRetries: 3 });
    const claimed = await tasks.claim(task.id, 'w1');
    // Manually backdate claimedAt to simulate staleness
    claimed!.claimedAt = Date.now() - 120_000;
    await storage.save(`future-task:${task.id}`, claimed);

    const recovered = await tasks.recover(60_000);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.status).toBe('pending');
    expect(recovered[0]!.retryCount).toBe(1);
  });

  it('allows the configured retry after lease expiry', async () => {
    const { storage, tasks } = store();
    await storage.init();
    const task = await tasks.schedule({ type: 'test', payload: {}, owner: 'bot-1', maxRetries: 1 });
    const claimed = await tasks.claim(task.id, 'w1');
    claimed!.claimedAt = Date.now() - 120_000;
    await storage.save(`future-task:${task.id}`, claimed);

    const recovered = await tasks.recover(60_000);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.status).toBe('pending');
    expect(recovered[0]!.retryCount).toBe(1);
    const retried = await tasks.claim(task.id, 'w2');
    retried!.claimedAt = Date.now() - 120_000;
    await storage.save(`future-task:${task.id}`, retried);
    const exhausted = await tasks.recover(60_000);
    expect(exhausted[0]!.status).toBe('failed');
  });

  it('list filters by status, owner, and type', async () => {
    const { storage, tasks } = store();
    await storage.init();
    await tasks.schedule({ type: 'email', payload: {}, owner: 'bot-1' });
    await tasks.schedule({ type: 'sms', payload: {}, owner: 'bot-2' });
    const t3 = await tasks.schedule({ type: 'email', payload: {}, owner: 'bot-1' });
    await tasks.claim(t3.id, 'w1');

    expect(await tasks.list({ status: 'pending' })).toHaveLength(2);
    expect(await tasks.list({ owner: 'bot-1' })).toHaveLength(2);
    expect(await tasks.list({ type: 'sms' })).toHaveLength(1);
    expect(await tasks.list({ status: 'claimed' })).toHaveLength(1);
  });

  it('pending returns due tasks in order', async () => {
    const { storage, tasks } = store();
    await storage.init();
    const now = Date.now();
    await tasks.schedule({ id: 'later', type: 'test', payload: {}, owner: 'bot-1', scheduledAt: now + 100 });
    await tasks.schedule({ id: 'earlier', type: 'test', payload: {}, owner: 'bot-1', scheduledAt: now - 100 });
    await tasks.schedule({ id: 'future', type: 'test', payload: {}, owner: 'bot-1', scheduledAt: now + 60_000 });

    const pending = await tasks.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe('earlier');
  });

  it('validates input constraints', async () => {
    const { storage, tasks } = store();
    await storage.init();
    await expect(tasks.schedule({ type: '', payload: {}, owner: 'bot-1' })).rejects.toThrow('invalid task type');
    await expect(tasks.schedule({ type: 'test', payload: {}, owner: '' })).rejects.toThrow('invalid owner');
  });

  it('skips malformed records', async () => {
    const { storage, tasks } = store();
    await storage.init();
    await storage.save('future-task:bad', { kind: 'wrong', recordVersion: 1 });
    await storage.save('future-task:future-v', { kind: 'future-task', recordVersion: 99 });
    await tasks.schedule({ type: 'test', payload: {}, owner: 'bot-1' });

    const all = await tasks.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.type).toBe('test');
  });

  it('reconciles uncertain delivery records without retrying unknown outcomes', async () => {
    const { storage, tasks } = store();
    await storage.init();
    const task = await tasks.schedule({ type: 'discord.deliver', payload: { dedupeKey: 'k' }, owner: 'admin' });
    await tasks.claim(task.id, 'worker');
    await tasks.uncertain(task.id, 'network timeout');
    const unchanged = await tasks.reconcile(task.id, 'unknown', 'outbox still ambiguous');
    expect(unchanged.status).toBe('uncertain');
    expect(unchanged.error).toBe('outbox still ambiguous');
    const completed = await tasks.reconcile(task.id, 'delivered');
    expect(completed.status).toBe('completed');
  });
});
