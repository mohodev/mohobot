import { beforeEach, describe, expect, it } from 'vitest';
import { createNullLogger } from '../core/logger.js';
import { MemoryStorage } from '../storage/memory.js';
import type { MemoryDeletionNotification, MemoryDeletionSink } from './deletion-coordinator.js';
import { MemoryDeletionCoordinator } from './deletion-coordinator.js';

const notification = (overrides: Partial<MemoryDeletionNotification> = {}): MemoryDeletionNotification => ({
  botId: 'bot',
  sourceMessageId: 'msg:1',
  sourcePlatform: 'discord',
  deletedAt: 300,
  ...overrides,
});

function recordingSink(calls: MemoryDeletionNotification[]): MemoryDeletionSink {
  return {
    name: 'recording',
    async forgetSourceMessage(notification) {
      calls.push(notification);
    },
  };
}

describe('MemoryDeletionCoordinator', () => {
  let storage: MemoryStorage;
  beforeEach(async () => {
    storage = new MemoryStorage({ logger: createNullLogger() });
    await storage.init();
  });

  it('fans a deletion out to every registered sink exactly once', async () => {
    const calls: MemoryDeletionNotification[] = [];
    const sink = recordingSink(calls);
    const coordinator = new MemoryDeletionCoordinator({ storage, logger: createNullLogger() });
    coordinator.register(sink);
    coordinator.register(sink);

    await coordinator.notify(notification());
    await coordinator.notify(notification({ deletedAt: 999 }));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ sourceMessageId: 'msg:1', deletedAt: 300 });
  });

  it('keeps the deletion marker across restarts via storage', async () => {
    const first = new MemoryDeletionCoordinator({ storage, logger: createNullLogger() });
    await first.notify(notification());
    expect(await storage.query({ prefix: 'memory-deletion:' })).toHaveLength(1);

    const restartedCalls: MemoryDeletionNotification[] = [];
    const restarted = new MemoryDeletionCoordinator({ storage, logger: createNullLogger() });
    restarted.register(recordingSink(restartedCalls));
    await restarted.notify(notification());
    expect(restartedCalls).toHaveLength(0);
    expect(restarted.isDeleted('discord', 'msg:1')).toBe(true);
  });

  it('answers isDeleted in-process so late edits cannot resurrect content', async () => {
    const coordinator = new MemoryDeletionCoordinator({ logger: createNullLogger() });
    await coordinator.notify(notification({ sourceMessageId: 'gone' }));
    expect(coordinator.isDeleted('discord', 'gone')).toBe(true);
    expect(coordinator.isDeleted('discord', 'other')).toBe(false);
  });

  it('swallows sink failures and still records the deletion', async () => {
    const calls: MemoryDeletionNotification[] = [];
    const coordinator = new MemoryDeletionCoordinator({ logger: createNullLogger() });
    coordinator.register({
      name: 'broken',
      async forgetSourceMessage() {
        throw new Error('boom');
      },
    });
    coordinator.register(recordingSink(calls));

    await expect(coordinator.notify(notification())).resolves.toBeUndefined();
    expect(coordinator.isDeleted('discord', 'msg:1')).toBe(true);
  });
});
