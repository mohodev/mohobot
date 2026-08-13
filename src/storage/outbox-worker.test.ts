import { afterEach, describe, expect, it } from 'vitest';
import { createNullLogger } from '../core/logger.js';
import { MemoryStorage } from './memory.js';
import { Outbox } from './outbox.js';
import { OutboxWorker, type RemoteMirror } from './outbox-worker.js';

let storage: MemoryStorage | undefined;
let worker: OutboxWorker | undefined;
async function make(): Promise<{ outbox: Outbox; sent: string[] }> {
  storage = new MemoryStorage({ logger: createNullLogger() });
  await storage.init();
  const sent: string[] = [];
  const mirror: RemoteMirror = { async send(event) { sent.push(event.eventId); } };
  const outbox = new Outbox(storage);
  worker = new OutboxWorker(outbox, mirror, createNullLogger(), {
    workerId: 'test-worker', pollIntervalMs: 5, batchSize: 3, concurrency: 2, retryDelayMs: 20,
  });
  return { outbox, sent };
}
afterEach(async () => { await worker?.stop(); await storage?.close(); worker = undefined; storage = undefined; });

describe('OutboxWorker', () => {
  it('flushes batches and marks successful events done', async () => {
    const { outbox, sent } = await make();
    for (let i = 0; i < 7; i += 1) await outbox.append({ eventId: `e${i}`, type: 'mirror', payload: i });
    expect(await worker!.flush()).toBe(7);
    expect(sent).toEqual(['e0', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6']);
    expect((await outbox.list('done'))).toHaveLength(7);
    expect(worker!.stats()).toMatchObject({ claimed: 7, sent: 7, failed: 0 });
  });

  it('never exceeds the configured mirror concurrency', async () => {
    storage = new MemoryStorage({ logger: createNullLogger() });
    await storage.init();
    const outbox = new Outbox(storage);
    let active = 0;
    let peak = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const mirror: RemoteMirror = { async send() { active += 1; peak = Math.max(peak, active); await gate; active -= 1; } };
    worker = new OutboxWorker(outbox, mirror, createNullLogger(), { workerId: 'limited', batchSize: 5, concurrency: 2 });
    for (let i = 0; i < 5; i += 1) await outbox.append({ eventId: `c${i}`, type: 'mirror', payload: i });
    const flushing = worker.flush();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(peak).toBe(2);
    release?.();
    await flushing;
  });

  it('releases failed sends with retry timing and retries later', async () => {
    storage = new MemoryStorage({ logger: createNullLogger() });
    await storage.init();
    const outbox = new Outbox(storage);
    let calls = 0;
    const mirror: RemoteMirror = { async send() { calls += 1; if (calls === 1) throw new Error('remote down'); } };
    worker = new OutboxWorker(outbox, mirror, createNullLogger(), { workerId: 'retry', retryDelayMs: 15 });
    await outbox.append({ eventId: 'retry-me', type: 'mirror', payload: {} });
    expect(await worker.flush()).toBe(1);
    expect(await outbox.get('retry-me')).toMatchObject({ status: 'failed', attempts: 1, lastError: 'remote down' });
    expect(await worker.flush()).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await worker.flush()).toBe(1);
    expect(await outbox.get('retry-me')).toMatchObject({ status: 'done', attempts: 2 });
  });

  it('polls after start and stop waits for the active batch', async () => {
    storage = new MemoryStorage({ logger: createNullLogger() });
    await storage.init();
    const outbox = new Outbox(storage);
    let started: (() => void) | undefined;
    let finish: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const mirror: RemoteMirror = { async send() { started?.(); await gate; } };
    worker = new OutboxWorker(outbox, mirror, createNullLogger(), { workerId: 'stopping', pollIntervalMs: 5 });
    await outbox.append({ eventId: 'slow', type: 'mirror', payload: {} });
    worker.start();
    await entered;
    let stopped = false;
    const stopping = worker.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish?.();
    await stopping;
    expect(worker.running).toBe(false);
    expect(await outbox.get('slow')).toMatchObject({ status: 'done' });
  });

  it('stop prevents future polling and flush becomes a no-op while stopping', async () => {
    const { outbox, sent } = await make();
    worker!.start();
    await worker!.stop();
    await outbox.append({ eventId: 'after-stop', type: 'mirror', payload: {} });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(sent).toEqual([]);
    expect(await outbox.get('after-stop')).toMatchObject({ status: 'pending' });
  });
});
