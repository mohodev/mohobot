import { describe, expect, it } from 'vitest';
import { createNullLogger } from '../core/logger.js';
import { MemoryStorage } from '../storage/memory.js';
import { ExpressionMemoryGovernance, type BulkDeleteFilter, type SanitizedExpressionRecord } from './expression-memory-governance.js';
import { EXPRESSION_MEMORY_PREFIX, type ExpressionMemoryRecord, validRecord } from './expression-memory.js';

function key(botId: string, userId: string, id: string): string {
  return `${EXPRESSION_MEMORY_PREFIX}${botId}:${userId}:${id}`;
}

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
    sourceCreatedAt: 900,
    ...overrides,
  };
}

async function fixture(now = 10_000) {
  const storage = new MemoryStorage({ logger: createNullLogger() });
  await storage.init();
  const governance = new ExpressionMemoryGovernance({ storage, logger: createNullLogger(), now: () => now });
  return { storage, governance };
}

describe('bulkDelete', () => {
  it('tombstones all matching records for a bot', async () => {
    const { storage, governance } = await fixture();
    await storage.save(key('bot', 'user1', 'a'), makeRecord({ id: 'a' }));
    await storage.save(key('bot', 'user1', 'b'), makeRecord({ id: 'b', channelId: 'ch2' }));
    await storage.save(key('bot', 'user2', 'c'), makeRecord({ id: 'c', userId: 'user2' }));

    const count = await governance.bulkDelete({ botId: 'bot' }, 'admin', 'cleanup');
    expect(count).toBe(3);

    const a = await storage.get<ExpressionMemoryRecord>(key('bot', 'user1', 'a'));
    expect(a!.tombstone).toBeDefined();
    expect(a!.tombstone!.reviewer).toBe('admin');
    expect(a!.tombstone!.reason).toBe('cleanup');
  });

  it('filters by userId', async () => {
    const { storage, governance } = await fixture();
    await storage.save(key('bot', 'user1', 'a'), makeRecord({ id: 'a' }));
    await storage.save(key('bot', 'user2', 'b'), makeRecord({ id: 'b', userId: 'user2' }));

    const count = await governance.bulkDelete({ botId: 'bot', userId: 'user1' }, 'admin');
    expect(count).toBe(1);

    const a = await storage.get<ExpressionMemoryRecord>(key('bot', 'user1', 'a'));
    const b = await storage.get<ExpressionMemoryRecord>(key('bot', 'user2', 'b'));
    expect(a!.tombstone).toBeDefined();
    expect(b!.tombstone).toBeUndefined();
  });

  it('filters by channelId', async () => {
    const { storage, governance } = await fixture();
    await storage.save(key('bot', 'user1', 'a'), makeRecord({ id: 'a', channelId: 'ch1' }));
    await storage.save(key('bot', 'user1', 'b'), makeRecord({ id: 'b', channelId: 'ch2' }));

    const count = await governance.bulkDelete({ botId: 'bot', channelId: 'ch1' }, 'admin');
    expect(count).toBe(1);
  });

  it('filters by before timestamp', async () => {
    const { storage, governance } = await fixture();
    await storage.save(key('bot', 'user1', 'a'), makeRecord({ id: 'a', createdAt: 500 }));
    await storage.save(key('bot', 'user1', 'b'), makeRecord({ id: 'b', createdAt: 2000 }));

    const count = await governance.bulkDelete({ botId: 'bot', before: 1000 }, 'admin');
    expect(count).toBe(1);

    const a = await storage.get<ExpressionMemoryRecord>(key('bot', 'user1', 'a'));
    const b = await storage.get<ExpressionMemoryRecord>(key('bot', 'user1', 'b'));
    expect(a!.tombstone).toBeDefined();
    expect(b!.tombstone).toBeUndefined();
  });

  it('skips already tombstoned records', async () => {
    const { storage, governance } = await fixture();
    const tombstoned = makeRecord({ id: 'a', tombstone: { at: 5000, reviewer: 'previous' } });
    await storage.save(key('bot', 'user1', 'a'), tombstoned);

    const count = await governance.bulkDelete({ botId: 'bot' }, 'admin');
    expect(count).toBe(0);
  });

  it('returns 0 for no matches', async () => {
    const { governance } = await fixture();
    const count = await governance.bulkDelete({ botId: 'nonexistent' }, 'admin');
    expect(count).toBe(0);
  });
});

describe('recycleBin', () => {
  it('lists tombstoned non-expired records', async () => {
    const { storage, governance } = await fixture(10_000);
    const tombstoned = makeRecord({ id: 'a', tombstone: { at: 5000, reviewer: 'admin' }, expiresAt: 99_999 });
    const alive = makeRecord({ id: 'b' });
    await storage.save(key('bot', 'user1', 'a'), tombstoned);
    await storage.save(key('bot', 'user1', 'b'), alive);

    const bin = await governance.recycleBin('bot');
    expect(bin).toHaveLength(1);
    expect(bin[0]!.id).toBe('a');
  });

  it('excludes expired tombstoned records', async () => {
    const { storage, governance } = await fixture(10_000);
    const expired = makeRecord({ id: 'a', tombstone: { at: 5000, reviewer: 'admin' }, expiresAt: 5000 });
    await storage.save(key('bot', 'user1', 'a'), expired);

    const bin = await governance.recycleBin('bot');
    expect(bin).toHaveLength(0);
  });

  it('includes tombstoned records without expiresAt', async () => {
    const { storage, governance } = await fixture(10_000);
    const noExpiry = makeRecord({ id: 'a', tombstone: { at: 5000, reviewer: 'admin' } });
    delete (noExpiry as any).expiresAt;
    await storage.save(key('bot', 'user1', 'a'), noExpiry);

    const bin = await governance.recycleBin('bot');
    expect(bin).toHaveLength(1);
  });

  it('respects limit', async () => {
    const { storage, governance } = await fixture(10_000);
    for (let i = 0; i < 5; i++) {
      const rec = makeRecord({ id: `r${i}`, tombstone: { at: 5000 + i, reviewer: 'admin' }, updatedAt: 3000 + i });
      delete (rec as any).expiresAt;
      await storage.save(key('bot', 'user1', `r${i}`), rec);
    }

    const bin = await governance.recycleBin('bot', 2);
    expect(bin).toHaveLength(2);
  });
});

describe('restore', () => {
  it('restores a tombstoned record to approved', async () => {
    const { storage, governance } = await fixture(10_000);
    const tombstoned = makeRecord({ id: 'a', status: 'rejected', tombstone: { at: 5000, reviewer: 'admin' }, expiresAt: 99_999 });
    await storage.save(key('bot', 'user1', 'a'), tombstoned);

    const outcome = await governance.restore('bot', 'user1', 'a', 'operator');
    expect(outcome).toBe('applied');

    const restored = await storage.get<ExpressionMemoryRecord>(key('bot', 'user1', 'a'));
    expect(restored!.status).toBe('approved');
    expect(restored!.tombstone).toBeUndefined();
    expect(restored!.reviewer).toBe('operator');
    expect(restored!.recordVersion).toBe(2);
  });

  it('returns unchanged for non-tombstoned records', async () => {
    const { storage, governance } = await fixture(10_000);
    await storage.save(key('bot', 'user1', 'a'), makeRecord({ id: 'a' }));

    const outcome = await governance.restore('bot', 'user1', 'a', 'admin');
    expect(outcome).toBe('unchanged');
  });

  it('returns not-found for missing records', async () => {
    const { governance } = await fixture(10_000);
    const outcome = await governance.restore('bot', 'user1', 'missing', 'admin');
    expect(outcome).toBe('not-found');
  });

  it('returns invalid for expired tombstoned records', async () => {
    const { storage, governance } = await fixture(10_000);
    const expired = makeRecord({ id: 'a', tombstone: { at: 1000, reviewer: 'admin' }, expiresAt: 5000 });
    await storage.save(key('bot', 'user1', 'a'), expired);

    const outcome = await governance.restore('bot', 'user1', 'a', 'admin');
    expect(outcome).toBe('invalid');
  });

  it('restores records without expiresAt', async () => {
    const { storage, governance } = await fixture(10_000);
    const noExpiry = makeRecord({ id: 'a', tombstone: { at: 5000, reviewer: 'admin' } });
    delete (noExpiry as any).expiresAt;
    await storage.save(key('bot', 'user1', 'a'), noExpiry);

    const outcome = await governance.restore('bot', 'user1', 'a', 'operator');
    expect(outcome).toBe('applied');
  });
});

describe('exportSanitized', () => {
  it('produces JSONL without userId, channelId, botId, sourceMessageId, or sourceCreatedAt', async () => {
    const { storage, governance } = await fixture();
    await storage.save(key('bot', 'user1', 'a'), makeRecord({
      id: 'a', userId: 'user1', channelId: 'ch1', botId: 'bot',
      sourceMessageId: 'msg:100', sourceCreatedAt: 900, sourcePlatform: 'discord',
    }));

    const jsonl = await governance.exportSanitized('bot');
    expect(jsonl).toBeTruthy();
    const lines = jsonl.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]!) as SanitizedExpressionRecord;
    expect(parsed.id).toBe('a');
    expect(parsed.category).toBe('preference');
    expect(parsed.text).toBe('用户偏好猫');
    expect(parsed.sourcePlatform).toBe('discord');
    expect(parsed.reviewer).toBeUndefined();
    expect((parsed as any).userId).toBeUndefined();
    expect((parsed as any).channelId).toBeUndefined();
    expect((parsed as any).botId).toBeUndefined();
    expect((parsed as any).sourceMessageId).toBeUndefined();
    expect((parsed as any).sourceCreatedAt).toBeUndefined();
    expect((parsed as any).kind).toBeUndefined();
  });

  it('filters by status', async () => {
    const { storage, governance } = await fixture();
    await storage.save(key('bot', 'user1', 'a'), makeRecord({ id: 'a', status: 'approved' }));
    await storage.save(key('bot', 'user1', 'b'), makeRecord({ id: 'b', status: 'pending' }));

    const jsonl = await governance.exportSanitized('bot', { status: 'pending' });
    const lines = jsonl.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).id).toBe('b');
  });

  it('respects limit', async () => {
    const { storage, governance } = await fixture();
    for (let i = 0; i < 5; i++) {
      await storage.save(key('bot', 'user1', `r${i}`), makeRecord({ id: `r${i}`, updatedAt: 2000 + i }));
    }

    const jsonl = await governance.exportSanitized('bot', { limit: 2 });
    const lines = jsonl.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
  });

  it('returns empty string when no records match', async () => {
    const { governance } = await fixture();
    const jsonl = await governance.exportSanitized('nonexistent');
    expect(jsonl).toBe('');
  });

  it('strips tombstone reviewer from export', async () => {
    const { storage, governance } = await fixture();
    const rec = makeRecord({ id: 'a', tombstone: { at: 5000, reviewer: 'secret-admin', reason: 'policy' } });
    await storage.save(key('bot', 'user1', 'a'), rec);

    const jsonl = await governance.exportSanitized('bot');
    const parsed = JSON.parse(jsonl.split('\n')[0]!);
    expect(parsed.tombstone).toBeDefined();
    expect(parsed.tombstone.at).toBe(5000);
    expect(parsed.tombstone.reason).toBe('policy');
    expect(parsed.tombstone.reviewer).toBeUndefined();
  });
});
