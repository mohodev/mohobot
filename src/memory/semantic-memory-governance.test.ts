import { describe, expect, it } from 'vitest';
import { createNullLogger } from '../core/logger.js';
import { MemoryStorage } from '../storage/memory.js';
import { SemanticMemoryGovernance } from './semantic-memory-governance.js';

describe('SemanticMemoryGovernance', () => {
  it('tombstones matching records, clears vectors, restores, and exports without identity fields', async () => {
    const storage = new MemoryStorage({ logger: createNullLogger() }); await storage.init();
    const key = 'semantic-memory:bot:user:1:id';
    await storage.save(key, { id: 'id', botId: 'bot', channelId: 'channel-secret', userId: 'user-secret', scope: 'private', text: 'private text', user: { role: 'user', content: 'x', sourceMessageId: 'source' }, assistant: { role: 'assistant', content: 'y' }, createdAt: 1, vector: [1, 2], embeddingModel: 'model' });
    let now = 5;
    const gov = new SemanticMemoryGovernance(storage, createNullLogger(), () => now);
    expect(await gov.bulkDelete({ botId: 'bot', sourceMessageId: 'source' }, 'admin', 'requested')).toBe(1);
    const deleted = await storage.get<any>(key);
    expect(deleted.tombstone).toMatchObject({ at: 5, reason: 'requested' });
    expect(deleted.vector).toBeUndefined();
    expect(await gov.recycleBin('bot')).toHaveLength(1);
    const exported = await gov.exportSanitized('bot');
    expect(exported).not.toContain('user-secret');
    expect(exported).not.toContain('channel-secret');
    expect(gov.dryRunImport(`${exported}\nnot-json`)).toMatchObject({ lines: 2, valid: 1, invalid: 1 });
    now = 6;
    expect(await gov.restore('bot', 'user-secret', 'id', 'admin')).toBe('applied');
    expect((await storage.get<any>(key)).tombstone).toBeUndefined();
  });

  it('deletes semantic records derived from a source message', async () => {
    const storage = new MemoryStorage({ logger: createNullLogger() }); await storage.init();
    const key = 'semantic-memory:bot:user:1:id';
    await storage.save(key, { id: 'id', botId: 'bot', channelId: 'channel', userId: 'user', scope: 'private', text: 'fact', user: { role: 'user', content: 'fact', sourceMessageId: 'msg', sourcePlatform: 'discord' }, assistant: { role: 'assistant', content: 'reply' }, createdAt: 1, vector: [1] });
    const gov = new SemanticMemoryGovernance(storage, createNullLogger());
    await gov.forgetSourceMessage({ botId: 'bot', sourceMessageId: 'msg', sourcePlatform: 'discord', deletedAt: 4 });
    expect((await storage.get<any>(key)).tombstone.at).toBe(4);
    expect((await storage.get<any>(key)).vector).toBeUndefined();
  });
});
