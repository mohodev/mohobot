import { describe, expect, it } from 'vitest';

import { renderWelcome } from './index.js';

describe('renderWelcome', () => {
  it('replaces placeholders', () => {
    const text = renderWelcome('欢迎 {user}（{username}），第 {count} 位成员', {
      botId: 'bot1',
      platform: 'discord',
      guildId: 'g1',
      userId: 'u1',
      username: 'alice',
      memberCount: 42,
      occurredAt: 1,
    });
    expect(text).toBe('欢迎 <@u1>（alice），第 42 位成员');
  });
});
