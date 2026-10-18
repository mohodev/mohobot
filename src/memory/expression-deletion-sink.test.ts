import { beforeEach, describe, expect, it } from 'vitest';
import { createNullLogger } from '../core/logger.js';
import { MemoryStorage } from '../storage/memory.js';
import { ExpressionDeletionSink } from './expression-deletion-sink.js';
import { EXPRESSION_MEMORY_PREFIX, type ExpressionMemoryRecord, validRecord } from './expression-memory.js';

function makeRecord(overrides: Partial<ExpressionMemoryRecord> = {}): ExpressionMemoryRecord {
  return {
    kind: 'expression-memory',
    recordVersion: 2,
    id: 'rec1',
    botId: 'bot',
    userId: 'user1',
    channelId: 'ch1',
    category: 'preference',
    text: '用户偏好猫',
    normalized: '用户偏好猫',
    status: 'approved',
    confidence: 0.9,
    createdAt: 1000,
    updatedAt: 2000,
    sourceMessageId: 'msg:100',
    sourcePlatform: 'discord',
    ...overrides,
  };
}

function key(botId: string, userId: string, id: string): string {
  return `${EXPRESSION_MEMORY_PREFIX}${botId}:${userId}:${id}`;
}

describe('ExpressionDeletionSink', () => {
  let storage: MemoryStorage;
  let sink: ExpressionDeletionSink;

  beforeEach(async () => {
    storage = new MemoryStorage({ logger: createNullLogger() });
    await storage.init();
    sink = new ExpressionDeletionSink({ storage, logger: createNullLogger() });
  });

  it('tombstones expression records matching the deleted sourceMessageId', async () => {
    const record = makeRecord();
    await storage.save(key('bot', 'user1', 'rec1'), record);

    await sink.forgetSourceMessage({
      botId: 'bot',
      sourceMessageId: 'msg:100',
      sourcePlatform: 'discord',
      userId: 'user1',
      deletedAt: 5000,
    });

    const updated = await storage.get<ExpressionMemoryRecord>(key('bot', 'user1', 'rec1'));
    expect(updated).toBeDefined();
    expect(validRecord(updated)).toBe(true);
    expect(updated!.tombstone).toBeDefined();
    expect(updated!.tombstone!.reviewer).toBe('deletion-coordinator');
    expect(updated!.tombstone!.reason).toContain('msg:100');
  });

  it('does not tombstone records with a different sourceMessageId', async () => {
    const record = makeRecord({ sourceMessageId: 'msg:999' });
    await storage.save(key('bot', 'user1', 'rec1'), record);

    await sink.forgetSourceMessage({
      botId: 'bot',
      sourceMessageId: 'msg:100',
      sourcePlatform: 'discord',
      userId: 'user1',
      deletedAt: 5000,
    });

    const updated = await storage.get<ExpressionMemoryRecord>(key('bot', 'user1', 'rec1'));
    expect(updated!.tombstone).toBeUndefined();
  });

  it('is idempotent: tombstoning an already-tombstoned record is a no-op', async () => {
    const record = makeRecord();
    await storage.save(key('bot', 'user1', 'rec1'), record);

    await sink.forgetSourceMessage({
      botId: 'bot',
      sourceMessageId: 'msg:100',
      sourcePlatform: 'discord',
      userId: 'user1',
      deletedAt: 5000,
    });
    await sink.forgetSourceMessage({
      botId: 'bot',
      sourceMessageId: 'msg:100',
      sourcePlatform: 'discord',
      userId: 'user1',
      deletedAt: 6000,
    });

    const updated = await storage.get<ExpressionMemoryRecord>(key('bot', 'user1', 'rec1'));
    expect(updated!.tombstone).toBeDefined();
  });

  it('tombstones multiple records from the same source message', async () => {
    const r1 = makeRecord({ id: 'a', sourceMessageId: 'msg:100' });
    const r2 = makeRecord({ id: 'b', sourceMessageId: 'msg:100', category: 'boundary', text: '用户不希望X', normalized: '用户不希望x' });
    await storage.save(key('bot', 'user1', 'a'), r1);
    await storage.save(key('bot', 'user1', 'b'), r2);

    await sink.forgetSourceMessage({
      botId: 'bot',
      sourceMessageId: 'msg:100',
      sourcePlatform: 'discord',
      userId: 'user1',
      deletedAt: 5000,
    });

    const u1 = await storage.get<ExpressionMemoryRecord>(key('bot', 'user1', 'a'));
    const u2 = await storage.get<ExpressionMemoryRecord>(key('bot', 'user1', 'b'));
    expect(u1!.tombstone).toBeDefined();
    expect(u2!.tombstone).toBeDefined();
  });

  it('scans by botId prefix when userId is not provided', async () => {
    const record = makeRecord({ userId: 'unknown-user' });
    await storage.save(key('bot', 'unknown-user', 'rec1'), record);

    await sink.forgetSourceMessage({
      botId: 'bot',
      sourceMessageId: 'msg:100',
      sourcePlatform: 'discord',
      deletedAt: 5000,
    });

    const updated = await storage.get<ExpressionMemoryRecord>(key('bot', 'unknown-user', 'rec1'));
    expect(updated!.tombstone).toBeDefined();
  });

  it('does not throw when storage query fails', async () => {
    await storage.close();
    // After close, queries fail. The sink should swallow errors gracefully.
    await expect(sink.forgetSourceMessage({
      botId: 'bot',
      sourceMessageId: 'msg:100',
      sourcePlatform: 'discord',
      deletedAt: 5000,
    })).resolves.toBeUndefined();
  });
});
