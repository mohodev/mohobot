import { describe, expect, it, vi } from 'vitest';
import { EventBus } from './event.js';
import { createNullLogger } from './logger.js';
import { Supervisor } from './supervisor.js';
import { SupervisorConfigSchema } from '../config/schema.js';
import type { Managed } from './types.js';

function makeConfig(overrides: Partial<ReturnType<typeof SupervisorConfigSchema.parse>> = {}) {
  return SupervisorConfigSchema.parse({
    backoffBaseMs: 10,
    backoffMaxMs: 40,
    restartWindowMs: 10_000,
    shutdownTimeoutMs: 200,
    ...overrides,
  });
}

function makeSupervisor(configOverrides = {}) {
  const events = new EventBus();
  const logger = createNullLogger();
  return new Supervisor({ config: makeConfig(configOverrides), logger, events });
}

class FakeComponent implements Managed {
  starts = 0;
  stops = 0;
  failNextStarts = 0;
  stopHangs = false;

  constructor(readonly name: string) {}

  async start(): Promise<void> {
    this.starts += 1;
    if (this.failNextStarts > 0) {
      this.failNextStarts -= 1;
      throw new Error('start boom');
    }
  }

  async stop(): Promise<void> {
    this.stops += 1;
    if (this.stopHangs) await new Promise(() => {});
  }
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Supervisor', () => {
  it('starts a component and reports running', async () => {
    const sup = makeSupervisor();
    const c = new FakeComponent('a');
    sup.register(c);
    expect(await sup.startComponent('a')).toBe(true);
    expect(c.starts).toBe(1);
    expect(sup.status()[0]?.state).toBe('running');
    expect(sup.healthy()).toBe(true);
    await sup.shutdown();
  });

  it('refuses duplicate registration', () => {
    const sup = makeSupervisor();
    sup.register(new FakeComponent('dup'));
    expect(() => sup.register(new FakeComponent('dup'))).toThrow(/already registered/);
  });

  it('isolates a start failure and keeps siblings running', async () => {
    const sup = makeSupervisor({ autoRestart: false });
    const bad = new FakeComponent('bad');
    bad.failNextStarts = 99;
    const good = new FakeComponent('good');
    sup.register(bad);
    sup.register(good);

    await sup.startAll();

    const byName = Object.fromEntries(sup.status().map((s) => [s.name, s]));
    expect(byName.bad?.state).toBe('crashed');
    expect(byName.good?.state).toBe('running');
    expect(sup.healthy()).toBe(false);
    await sup.shutdown();
  });

  it('auto-restarts a crashed component with backoff', async () => {
    const sup = makeSupervisor({ autoRestart: true, maxRestarts: 5 });
    const c = new FakeComponent('flaky');
    sup.register(c);
    await sup.startComponent('flaky');
    expect(c.starts).toBe(1);

    sup.reportFailure('flaky', new Error('died'));
    expect(sup.status()[0]?.state).toBe('crashed');

    await tick(120);
    expect(c.starts).toBeGreaterThanOrEqual(2);
    expect(sup.status()[0]?.state).toBe('running');
    await sup.shutdown();
  });

  it('defers a retryAt failure without consuming the ordinary restart budget', async () => {
    const sup = makeSupervisor({ autoRestart: true, maxRestarts: 1 });
    const c = new FakeComponent('quota-limited');
    sup.register(c);
    await sup.startComponent('quota-limited');
    const error = Object.assign(new Error('Discord session starts exhausted'), { retryAt: Date.now() + 60_000 });
    sup.reportFailure('quota-limited', error);
    await tick(80);
    expect(c.starts).toBe(1);
    expect(sup.status()[0]?.restarts).toBe(0);
    await sup.shutdown();
  });

  it('gives up after maxRestarts and calls onFatal for a critical component', async () => {
    const sup = makeSupervisor({ autoRestart: true, maxRestarts: 2 });
    const onFatal = vi.fn();
    sup.onFatal(onFatal);
    const c = new FakeComponent('critical');
    c.failNextStarts = 99;
    sup.register(c, { critical: true });

    await sup.startComponent('critical');
    await tick(400);

    expect(onFatal).toHaveBeenCalled();
    expect(sup.status()[0]?.state).toBe('crashed');
    await sup.shutdown();
  });

  it('runs the onRestart hook before restarting', async () => {
    const sup = makeSupervisor();
    const c = new FakeComponent('hooked');
    const onRestart = vi.fn(async () => {});
    sup.register(c, { onRestart });
    await sup.startComponent('hooked');
    await sup.restartComponent('hooked');
    expect(onRestart).toHaveBeenCalledOnce();
    expect(c.stops).toBe(1);
    expect(c.starts).toBe(2);
    await sup.shutdown();
  });

  it('forces state to stopped when stop() hangs past the timeout', async () => {
    const sup = makeSupervisor({ shutdownTimeoutMs: 50 });
    const c = new FakeComponent('hang');
    c.stopHangs = true;
    sup.register(c);
    await sup.startComponent('hang');
    await sup.stopComponent('hang');
    expect(sup.status()[0]?.state).toBe('stopped');
  });

  it('contains an unhandled rejection instead of exiting', async () => {
    const sup = makeSupervisor({ crashOnUnhandled: false });
    const onFatal = vi.fn();
    sup.onFatal(onFatal);
    sup.installGlobalHandlers();

    process.emit('unhandledRejection', new Error('stray'), Promise.resolve());
    await tick(10);

    expect(onFatal).not.toHaveBeenCalled();
    sup.removeGlobalHandlers();
  });

  it('stops components in reverse registration order on shutdown', async () => {
    const sup = makeSupervisor();
    const order: string[] = [];
    const mk = (name: string): Managed => ({
      name,
      start: async () => {},
      stop: async () => {
        order.push(name);
      },
    });
    sup.register(mk('first'));
    sup.register(mk('second'));
    await sup.startAll();
    await sup.shutdown();
    expect(order).toEqual(['second', 'first']);
  });
});
