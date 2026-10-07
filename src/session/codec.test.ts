import { describe, expect, it } from 'vitest';

import { decodePersistedSession, decodeSessionSummary, SESSION_RECORD_VERSION } from './codec.js';

const key = 'session:b:c:u';
const base = { kind: 'session', key, botId: 'b', channelId: 'c', userId: 'u', messages: [{ role: 'user', content: 'hi' }], updatedAt: 5 };

describe('session codec versions and summaries', () => {
  it('reads v1 records and reports no summary', () => {
    const decoded = decodePersistedSession({ ...base, recordVersion: 1 }, key);
    expect(decoded.ok && decoded.value.recordVersion).toBe(1);
    expect(decoded.ok && decoded.value.summary).toBeUndefined();
  });

  it('reads v2 records with a summary', () => {
    const decoded = decodePersistedSession({ ...base, recordVersion: 2, summary: { text: ' notes ', updatedAt: 9, coveredMessages: 12.7 } }, key);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.recordVersion).toBe(2);
      expect(decoded.value.summary).toEqual({ text: 'notes', updatedAt: 9, coveredMessages: 12 });
    }
  });

  it('rejects versions newer than this build understands', () => {
    expect(SESSION_RECORD_VERSION).toBe(2);
    expect(decodePersistedSession({ ...base, recordVersion: 3 }, key)).toEqual({ ok: false, reason: 'future_version' });
  });

  it('drops only the summary when it is malformed', () => {
    for (const summary of [{ text: 7, updatedAt: 1 }, { text: '  ', updatedAt: 1 }, { text: 'x', updatedAt: 'now' }, { text: 'x'.repeat(20_001), updatedAt: 1 }, 'str', null]) {
      const decoded = decodePersistedSession({ ...base, recordVersion: 2, summary }, key);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        expect(decoded.value.summary).toBeUndefined();
        expect(decoded.value.recordVersion).toBe(1);
        expect(decoded.value.messages).toHaveLength(1);
      }
    }
  });

  it('defaults coveredMessages to 0 when absent or invalid', () => {
    expect(decodeSessionSummary({ text: 'a', updatedAt: 1 })?.coveredMessages).toBe(0);
    expect(decodeSessionSummary({ text: 'a', updatedAt: 1, coveredMessages: -4 })?.coveredMessages).toBe(0);
  });
});
