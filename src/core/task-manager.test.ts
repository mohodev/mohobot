import { describe, expect, it } from 'vitest';
import { EventBus } from './event.js';
import { createNullLogger } from './logger.js';
import { TaskManager } from './task-manager.js';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeManager() {
  return new TaskManager({ logger: createNullLogger(), events: new EventBus() });
}

describe('TaskManager', () => {
  it('runs a one-shot task and marks it done', async () => {
    const tm = makeManager();
    let ran = false;
    tm.spawn(
      async () => {
        ran = true;
      },
      { name: 'once' },
    );
    await tick(20);
    expect(ran).toBe(true);
    await tm.stopAll();
  });

  it('contains a throwing task instead of rejecting', async () => {
    const tm = makeManager();
    const id = tm.spawn(
      async () => {
        throw new Error('boom');
      },
      { name: 'bad' },
    );
    await tick(20);
    const info = tm.list().find((t) => t.id === id);
    // one-shot failures stay in the registry with state failed
    expect(info?.state).toBe('failed');
    expect(info?.errors).toBe(1);
    expect(info?.lastError).toContain('boom');
    await tm.stopAll();
  });

  it('repeats an interval task and can be cancelled', async () => {
    const tm = makeManager();
    let runs = 0;
    const id = tm.spawn(
      async () => {
        runs += 1;
      },
      { name: 'tick', intervalMs: 10, immediate: true },
    );
    await tick(60);
    expect(runs).toBeGreaterThanOrEqual(2);
    expect(tm.cancel(id)).toBe(true);
    const after = runs;
    await tick(40);
    expect(runs).toBe(after);
    await tm.stopAll();
  });

  it('does not pile up overlapping interval runs', async () => {
    const tm = makeManager();
    let concurrent = 0;
    let maxConcurrent = 0;
    tm.spawn(
      async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await tick(40);
        concurrent -= 1;
      },
      { name: 'slow', intervalMs: 5, immediate: true },
    );
    await tick(120);
    expect(maxConcurrent).toBe(1);
    await tm.stopAll();
  });

  it('times out a run that exceeds timeoutMs', async () => {
    const tm = makeManager();
    const id = tm.spawn(async () => tick(500), { name: 'hang', timeoutMs: 30 });
    await tick(80);
    const info = tm.list().find((t) => t.id === id);
    expect(info?.errors).toBe(1);
    expect(info?.lastError).toContain('timed out');
    await tm.stopAll();
  });

  it('aborts the task signal on cancel', async () => {
    const tm = makeManager();
    let aborted = false;
    const id = tm.spawn(
      async (ctx) => {
        ctx.signal.addEventListener('abort', () => {
          aborted = true;
        });
        await tick(200);
      },
      { name: 'abortable' },
    );
    await tick(10);
    tm.cancel(id);
    await tick(10);
    expect(aborted).toBe(true);
    await tm.stopAll();
  });

  it('stops interval tasks after stopAll and refuses new spawns', async () => {
    const tm = makeManager();
    let runs = 0;
    tm.spawn(
      async () => {
        runs += 1;
      },
      { name: 'x', intervalMs: 10, immediate: true },
    );
    await tick(30);
    await tm.stopAll();
    const before = runs;
    await tick(40);
    expect(runs).toBe(before);
    expect(tm.size).toBe(0);
    expect(tm.spawn(async () => {}, { name: 'late' })).toBe('');
  });

  it('cancelByName cancels every matching task', async () => {
    const tm = makeManager();
    tm.spawn(async () => tick(100), { name: 'group', intervalMs: 50 });
    tm.spawn(async () => tick(100), { name: 'group', intervalMs: 50 });
    tm.spawn(async () => tick(100), { name: 'other', intervalMs: 50 });
    expect(tm.cancelByName('group')).toBe(2);
    await tm.stopAll();
  });
});
