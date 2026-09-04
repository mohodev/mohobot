import { describe, expect, it } from 'vitest';

import { SessionConfigSchema } from '../config/schema.js';
import { createNullLogger } from '../core/logger.js';
import type { ChatMessage } from '../core/types.js';
import { SessionManager } from './manager.js';
import { compressSession, formatTranscript } from './summarizer.js';
import type { Session } from './types.js';

const logger = createNullLogger();
const input = { botId: 'bot1', channelId: 'chan1', userId: 'user1' };

function user(content: string): ChatMessage {
  return { role: 'user', content };
}

function assistant(content: string): ChatMessage {
  return { role: 'assistant', content };
}

function sessionWith(messages: ChatMessage[]): Session {
  return { key: 'session:bot1:chan1:user1', botId: 'bot1', channelId: 'chan1', userId: 'user1', messages, updatedAt: 0 };
}

describe('formatTranscript', () => {
  it('labels user, assistant and prior summaries', () => {
    const text = formatTranscript([
      { role: 'summary', content: '早期：用户喜欢猫。' },
      user('你好'),
      assistant('你好！'),
    ]);
    expect(text).toContain('已有摘要：早期：用户喜欢猫。');
    expect(text).toContain('用户：你好');
    expect(text).toContain('助手：你好！');
  });
});

describe('compressSession', () => {
  it('does nothing below the trigger count', async () => {
    const session = sessionWith([user('1'), assistant('1'), user('2')]);
    const result = await compressSession(session, 5, 2, 2, async () => 'sum');
    expect(result.compressed).toBe(false);
    expect(session.messages.length).toBe(3);
  });

  it('folds the oldest turns into a summary block and keeps the newest', async () => {
    const turns: ChatMessage[] = [];
    for (let i = 1; i <= 6; i += 1) {
      turns.push(user(`q${i}`), assistant(`a${i}`));
    }
    const session = sessionWith([...turns]);
    const seen: ChatMessage[][] = [];
    const result = await compressSession(session, 8, 4, 4, async (messages) => {
      seen.push(messages);
      return '压缩后的摘要';
    });

    expect(result.compressed).toBe(true);
    expect(result.folded).toBe(4);
    // 1 summary + 4 kept turns.
    expect(session.messages.length).toBe(5);
    expect(session.messages[0]).toMatchObject({ role: 'summary', content: '压缩后的摘要' });
    expect(session.messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['q5', 'q6']);
  });

  it('merges an existing summary into the next summarization', async () => {
    const session = sessionWith([
      { role: 'summary', content: '早期：用户喜欢猫。' },
      user('q1'), assistant('a1'),
      user('q2'), assistant('a2'),
      user('q3'), assistant('a3'),
    ]);
    const seen: ChatMessage[][] = [];
    await compressSession(session, 6, 4, 2, async (messages) => {
      seen.push(messages);
      return '合并摘要';
    });
    expect(seen[0]?.[0]?.role).toBe('summary');
    expect(seen[0]?.[0]?.content).toBe('早期：用户喜欢猫。');
    expect(session.messages[0]).toMatchObject({ role: 'summary', content: '合并摘要' });
  });

  it('reports fallback and leaves the session untouched when the summarizer throws', async () => {
    const turns: ChatMessage[] = [];
    for (let i = 1; i <= 5; i += 1) turns.push(user(`q${i}`), assistant(`a${i}`));
    const session = sessionWith([...turns]);
    const before = [...session.messages];

    const result = await compressSession(session, 6, 4, 2, async () => {
      throw new Error('model down');
    });

    expect(result.compressed).toBe(false);
    expect(result.fallback).toBe('summarize_failed');
    expect(session.messages).toEqual(before);
  });

  it('drops the folded turns but keeps going without a summary when the model returns empty', async () => {
    const turns: ChatMessage[] = [];
    for (let i = 1; i <= 5; i += 1) turns.push(user(`q${i}`), assistant(`a${i}`));
    const session = sessionWith([...turns]);

    const result = await compressSession(session, 6, 4, 2, async () => '   ');

    expect(result.compressed).toBe(false);
    expect(session.messages.some((m) => m.role === 'summary')).toBe(false);
    expect(session.messages.length).toBe(2);
  });
});

describe('SessionManager summary integration', () => {
  it('compresses via the injected summarizer before the hard trim', async () => {
    const cfg = SessionConfigSchema.parse({
      persist: false,
      maxMessages: 40,
      summary: { enabled: true, triggerMessages: 6, removeMessages: 4, keepMessages: 4 },
    });
    let calls = 0;
    const mgr = new SessionManager({
      botId: 'bot1',
      config: cfg,
      logger,
      summarize: async () => {
        calls += 1;
        return '对话摘要';
      },
    });

    for (let i = 1; i <= 4; i += 1) {
      await mgr.append(input, user(`q${i}`));
      await mgr.append(input, assistant(`a${i}`));
    }
    expect(calls).toBeGreaterThanOrEqual(1);

    const session = await mgr.get(input);
    expect(session.messages[0]?.role).toBe('summary');
    expect(session.messages.filter((m) => m.role === 'summary').length).toBe(1);
  });

  it('applies the plain hard trim when summarization is disabled', async () => {
    const cfg = SessionConfigSchema.parse({
      persist: false,
      maxMessages: 4,
      summary: { enabled: false },
    });
    const mgr = new SessionManager({ botId: 'bot1', config: cfg, logger });
    for (let i = 1; i <= 5; i += 1) await mgr.append(input, user(`q${i}`));

    const session = await mgr.get(input);
    expect(session.messages.length).toBe(4);
    expect(session.messages.some((m) => m.role === 'summary')).toBe(false);
  });
});
