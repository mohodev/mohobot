import { describe, expect, it } from 'vitest';
import { createNullLogger } from '../core/logger.js';
import { MemoryStorage } from '../storage/memory.js';
import { DiscordDeliveryOutbox } from './outbox.js';

describe('DiscordDeliveryOutbox', () => {
  it('reserves a dedupe key once and permits a confirmed rejection to retry', async () => {
    const storage = new MemoryStorage({ logger: createNullLogger() });
    await storage.init();
    const outbox = new DiscordDeliveryOutbox(storage);
    const input = { dedupeKey: 'task:one', botId: 'main', channelId: '123', content: 'hello' };
    expect((await outbox.reserve(input)).reserved).toBe(true);
    expect((await outbox.reserve(input)).reserved).toBe(false);
    await outbox.record(input.dedupeKey, { status: 'rejected', error: 'not sent' });
    expect((await outbox.reserve(input)).reserved).toBe(true);
    await outbox.record(input.dedupeKey, { status: 'delivered', messageId: 'm1' });
    expect((await outbox.reserve(input)).reserved).toBe(false);
  });
});
