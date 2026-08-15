import { describe, expect, it } from 'vitest';
import { createNullLogger } from '../core/logger.js';
import { MemoryStorage } from '../storage/memory.js';
import { ProfileReflectionWorker, type UserProfile } from './profile-reflection.js';

describe('ProfileReflectionWorker', () => {
  it('keeps explicit non-sensitive preferences and channel reflection', async () => {
    const storage = new MemoryStorage({ logger: createNullLogger() }); await storage.init();
    const worker = new ProfileReflectionWorker(storage, createNullLogger(), () => 100);
    await worker.reflect({ botId: 'b', channelId: 'c', userId: 'u', userText: '我喜欢爵士乐。请叫我小墨。' });
    const profile = await storage.get<UserProfile>('profile:b:u');
    expect(profile?.facts).toEqual(expect.arrayContaining(['爵士乐', '小墨']));
    expect(await storage.get('reflection:b:c')).toMatchObject({ exchanges: 1, lastExchangeAt: 100 });
  });
  it('does not extract facts from sensitive-looking messages', async () => {
    const storage = new MemoryStorage({ logger: createNullLogger() }); await storage.init();
    const worker = new ProfileReflectionWorker(storage, createNullLogger());
    await worker.reflect({ botId: 'b', channelId: 'c', userId: 'u', userText: '我的密码是 abc，我喜欢测试。' });
    expect(await storage.get('profile:b:u')).toBeUndefined();
  });
});
