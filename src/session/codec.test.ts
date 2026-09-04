import { describe, expect, it } from 'vitest';

import { decodePersistedSession } from './codec.js';

describe('session codec', () => {
  it('round-trips a summary role message', () => {
    const record = {
      kind: 'session',
      recordVersion: 1,
      key: 'session:bot1:chan1:user1',
      botId: 'bot1',
      channelId: 'chan1',
      userId: 'user1',
      updatedAt: 1,
      messages: [
        { role: 'summary', content: '早期对话摘要' },
        { role: 'user', content: '你好', name: 'alice' },
        { role: 'assistant', content: '你好！' },
      ],
    };
    const decoded = decodePersistedSession(record, record.key);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.messages[0]).toMatchObject({ role: 'summary', content: '早期对话摘要' });
      expect(decoded.droppedMessages).toBe(0);
    }
  });

  it('rejects unknown roles', () => {
    const record = {
      kind: 'session',
      recordVersion: 1,
      key: 'session:bot1:chan1:user1',
      botId: 'bot1',
      channelId: 'chan1',
      updatedAt: 1,
      messages: [{ role: 'tool', content: 'nope' }],
    };
    const decoded = decodePersistedSession(record, record.key);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.droppedMessages).toBe(1);
      expect(decoded.value.messages.length).toBe(0);
    }
  });
});
