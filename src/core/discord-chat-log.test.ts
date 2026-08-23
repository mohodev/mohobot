import { describe, expect, it } from 'vitest';
import { DiscordChatLogBuffer, DISCORD_CHAT_LOG_QUERY_LIMIT, discordChatLog } from './discord-chat-log.js';

function record(buffer: DiscordChatLogBuffer, seq: number, overrides: Partial<Parameters<DiscordChatLogBuffer['record']>[0]> = {}) {
  return buffer.record({ platform: 'discord', direction: 'in', botId: 'main', channelId: 'ch-1', userId: `u-${seq}`, content: `hello ${seq}`, outcome: 'received', time: 1_000 + seq, ...overrides });
}

describe('DiscordChatLogBuffer', () => {
  it('caps the ring buffer at capacity and keeps only the newest entries', () => {
    const buffer = new DiscordChatLogBuffer({ capacity: 3 });
    for (let i = 1; i <= 5; i += 1) record(buffer, i);
    const items = buffer.query({ limit: 100 });
    expect(items).toHaveLength(3);
    expect(items.map((entry) => entry.summary)).toEqual(['hello 5', 'hello 4', 'hello 3']);
    expect(items[0]!.seq).toBeGreaterThan(items[2]!.seq);
  });

  it('truncates content summaries to 500 characters by default', () => {
    const buffer = new DiscordChatLogBuffer();
    const entry = record(buffer, 1, { content: 'x'.repeat(600) });
    expect(entry!.summary).toHaveLength(500);
    expect(entry!.summary.endsWith('…')).toBe(true);
    const tight = new DiscordChatLogBuffer({ maxSummaryLength: 10 });
    expect(record(tight, 2, { content: 'y'.repeat(50) })!.summary).toHaveLength(10);
  });

  it('records discord traffic only - console and webhook platforms are never stored', () => {
    const buffer = new DiscordChatLogBuffer();
    expect(record(buffer, 1, { platform: 'console' })).toBeUndefined();
    expect(record(buffer, 2, { platform: 'webhook' })).toBeUndefined();
    expect(buffer.query()).toEqual([]);
    expect(record(buffer, 3)).toBeDefined();
    expect(buffer.query()).toHaveLength(1);
  });

  it('returns newest-first entries bounded by the query limit and supports filters', () => {
    const buffer = new DiscordChatLogBuffer();
    for (let i = 1; i <= 7; i += 1) {
      record(buffer, i, { direction: i % 2 === 0 ? 'out' : 'in', channelId: i > 5 ? 'ch-2' : 'ch-1', botId: i > 6 ? 'other' : 'main', outcome: i % 2 === 0 ? 'delivered' : 'received' });
    }
    expect(buffer.query({ limit: 3 })).toHaveLength(3);
    expect(buffer.query({ direction: 'out' }).every((entry) => entry.direction === 'out')).toBe(true);
    expect(buffer.query({ channelId: 'ch-2' })).toHaveLength(2);
    expect(buffer.query({ botId: 'other' })).toHaveLength(1);
    expect(buffer.query({ channelId: 'missing' })).toEqual([]);
    const clamped = new DiscordChatLogBuffer({ capacity: DISCORD_CHAT_LOG_QUERY_LIMIT + 50 });
    for (let i = 0; i < DISCORD_CHAT_LOG_QUERY_LIMIT + 20; i += 1) record(clamped, i);
    expect(clamped.query({ limit: DISCORD_CHAT_LOG_QUERY_LIMIT + 1 })).toHaveLength(DISCORD_CHAT_LOG_QUERY_LIMIT);
  });

  it('defaults outcomes by direction and carries trace ids through structured copies', () => {
    const buffer = new DiscordChatLogBuffer();
    const inbound = record(buffer, 1, { traceId: 'ct_in' })!;
    const outbound = record(buffer, 2, { direction: 'out', userId: 'bot-main', outcome: 'delivery_failed', traceId: 'ct_out' })!;
    expect(inbound.outcome).toBe('received');
    expect(outbound.outcome).toBe('delivery_failed');
    expect(outbound.userId).toBe('bot-main');
    expect(inbound.traceId).toBe('ct_in');
    inbound.seq = -1;
    expect(buffer.query()[1]!.seq).not.toBe(-1);
  });

  it('clears on demand and shares one process-wide singleton', () => {
    const buffer = new DiscordChatLogBuffer();
    record(buffer, 1);
    buffer.clear();
    expect(buffer.query()).toEqual([]);
    expect(discordChatLog).toBeInstanceOf(DiscordChatLogBuffer);
  });
});
