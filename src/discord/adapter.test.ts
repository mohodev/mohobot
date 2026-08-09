/**
 * Pure adapter tests: no network, no discord.js client, no token.
 */

import { describe, expect, it } from 'vitest';

import {
  chunkContent,
  sanitizeOutbound,
  toMohoMessage,
  type AdapterMessageInput,
} from './adapter.js';

const ZWJ = String.fromCharCode(0x200d);

function guildInput(over: Partial<AdapterMessageInput> = {}): AdapterMessageInput {
  return {
    id: 'm1',
    content: 'hello bot',
    author: { id: 'u1', username: 'alice', globalName: 'Alice A.', bot: false },
    channelId: 'c1',
    guildId: 'g1',
    channelName: 'general',
    isDM: false,
    mentionsBot: true,
    replyToId: 'm0',
    attachments: [
      { id: 'a1', url: 'https://cdn.example/a.png', name: 'a.png', contentType: 'image/png', size: 12 },
    ],
    createdTimestamp: 1_700_000_000_000,
    botId: 'bot-1',
    ...over,
  };
}

describe('toMohoMessage', () => {
  it('maps every field of a guild message', () => {
    const input = guildInput();
    const msg = toMohoMessage(input);

    expect(msg.id).toBe('m1');
    expect(msg.platform).toBe('discord');
    expect(msg.botId).toBe('bot-1');
    expect(msg.content).toBe('hello bot');
    expect(msg.mentionsBot).toBe(true);
    expect(msg.replyToId).toBe('m0');
    expect(msg.createdAt).toBe(1_700_000_000_000);

    expect(msg.channel).toEqual({ id: 'c1', guildId: 'g1', name: 'general', dm: false });
    expect(msg.author).toEqual({
      id: 'u1',
      username: 'alice',
      displayName: 'Alice A.',
      bot: false,
    });

    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0]).toEqual({
      id: 'a1',
      url: 'https://cdn.example/a.png',
      name: 'a.png',
      contentType: 'image/png',
      size: 12,
    });

    // the original object is preserved untouched
    expect(msg.raw).toBe(input);
  });

  it('maps a DM: no guild id, dm true, username fallback for displayName', () => {
    const msg = toMohoMessage(
      guildInput({
        guildId: undefined,
        channelName: undefined,
        isDM: true,
        author: { id: 'u2', username: 'bob', bot: false },
        attachments: [],
        replyToId: undefined,
      }),
    );

    expect(msg.channel.dm).toBe(true);
    expect(msg.channel.guildId).toBeUndefined();
    expect(msg.channel.name).toBeUndefined();
    expect(msg.author.displayName).toBe('bob');
    expect(msg.replyToId).toBeUndefined();
    expect(msg.attachments).toEqual([]);
  });

  it('honours an explicit platform and raw override', () => {
    const msg = toMohoMessage(guildInput({ platform: 'console', raw: { line: 'hi' } }));
    expect(msg.platform).toBe('console');
    expect(msg.raw).toEqual({ line: 'hi' });
  });
});

describe('chunkContent', () => {
  it('returns a single chunk when the text fits', () => {
    expect(chunkContent('short', 100)).toEqual(['short']);
  });

  it('returns nothing for empty input', () => {
    expect(chunkContent('', 100)).toEqual([]);
  });

  it('splits long text and never exceeds the limit', () => {
    const text = 'x'.repeat(500);
    const chunks = chunkContent(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(100);
    expect(chunks.join('')).toBe(text);
  });

  it('prefers the last newline before the limit', () => {
    const text = `${'a'.repeat(40)}\n${'b'.repeat(40)}\n${'c'.repeat(40)}`;
    const chunks = chunkContent(text, 50);
    expect(chunks[0]).toBe('a'.repeat(40));
    expect(chunks[1]).toBe('b'.repeat(40));
    expect(chunks[2]).toBe('c'.repeat(40));
  });

  it('falls back to the last space when there is no newline', () => {
    const text = `${'a'.repeat(30)} ${'b'.repeat(30)}`;
    const chunks = chunkContent(text, 40);
    expect(chunks[0]).toBe('a'.repeat(30));
    expect(chunks[1]).toBe('b'.repeat(30));
  });

  it('closes and reopens a fenced code block across the boundary', () => {
    const body = Array.from({ length: 40 }, (_, i) => `const x${i} = ${i};`).join('\n');
    const text = `intro line\n\`\`\`ts\n${body}\n\`\`\`\noutro line`;

    const chunks = chunkContent(text, 200);
    expect(chunks.length).toBeGreaterThan(1);

    const first = chunks[0] ?? '';
    const second = chunks[1] ?? '';

    expect(first.endsWith('```')).toBe(true);
    expect(second.startsWith('```ts')).toBe(true);

    // every chunk has a balanced number of fences
    for (const chunk of chunks) {
      const fences = chunk.split('```').length - 1;
      expect(fences % 2).toBe(0);
      expect(chunk.length).toBeLessThanOrEqual(200);
    }
  });

  it('drops empty chunks', () => {
    const text = `${'a'.repeat(60)}\n\n\n${'b'.repeat(60)}`;
    for (const chunk of chunkContent(text, 70)) {
      expect(chunk.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('sanitizeOutbound', () => {
  it('neutralises @everyone and @here when asked', () => {
    const out = sanitizeOutbound('ping @everyone and @here now', { suppressMentions: true });
    expect(out).not.toContain('@everyone');
    expect(out).not.toContain('@here');
    expect(out).toContain(`@${ZWJ}everyone`);
    expect(out).toContain(`@${ZWJ}here`);
  });

  it('leaves mentions alone when not suppressing', () => {
    expect(sanitizeOutbound('hi @everyone')).toBe('hi @everyone');
  });

  it('returns a single space for empty input', () => {
    expect(sanitizeOutbound('')).toBe(' ');
    expect(sanitizeOutbound('   \n\n  ')).toBe(' ');
  });

  it('trims and collapses blank line runs', () => {
    expect(sanitizeOutbound('  a\n\n\n\n\nb  ')).toBe('a\n\nb');
  });
});
