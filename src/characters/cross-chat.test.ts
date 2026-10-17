import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { AIProvider, ChatOptions } from '../ai/types.js';
import { AIError } from '../ai/types.js';
import type { ChatMessage } from '../core/types.js';
import { createNullLogger } from '../core/logger.js';
import { CharacterCatalog } from './catalog.js';
import { CROSS_CHAT_LIMITS, CrossChatError, CrossChatRunner } from './cross-chat.js';
import type { CrossChatOptions } from './cross-chat.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

async function makeCatalog(...ids: string[]): Promise<CharacterCatalog> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cross-chat-'));
  roots.push(root);
  const catalog = new CharacterCatalog(root);
  for (const id of ids) {
    await catalog.save({ id, name: id.toUpperCase(), prompt: `# ${id.toUpperCase()}\n\n${id} is a fictional test persona with a distinct ${id}-flavored speaking style.` });
  }
  return catalog;
}

type ScriptEntry = string | Error | ((call: number) => string);

function mockProvider(script: ScriptEntry[], onCall?: () => void): { provider: AIProvider; calls: Array<{ messages: ChatMessage[]; options?: ChatOptions }> } {
  const calls: Array<{ messages: ChatMessage[]; options?: ChatOptions }> = [];
  const provider: AIProvider = {
    name: 'mock',
    model: 'mock-model',
    async chat(messages, options) {
      const index = calls.length;
      calls.push({ messages, options });
      onCall?.();
      const entry = index < script.length ? script[index]! : script[script.length - 1]!;
      if (typeof entry === 'function') return { content: entry(index), model: 'mock-model', ms: 1 };
      if (entry instanceof Error) throw entry;
      return { content: entry, model: 'mock-model', ms: 1 };
    },
    health: async () => ({ ok: true }),
  };
  return { provider, calls };
}

/** Monotonic fake clock; the provider call hook advances it so totalMs is deterministic. */
function fakeClock(step = 50): { now: () => number; advance: () => void } {
  let t = 0;
  return { now: () => t, advance: () => { t += step; } };
}

/** Token sets are pairwise disjoint so the repetition guard never fires by accident. */
function distinctReply(i: number): string {
  return Array.from({ length: 8 }, (_, k) => `token${i * 8 + k}`).join(' ');
}

function runner(catalog: CharacterCatalog, provider: AIProvider, options: CrossChatOptions = {}): CrossChatRunner {
  return new CrossChatRunner({ catalog, provider, logger: createNullLogger(), options });
}

describe('CrossChatRunner happy path', () => {
  it('round-robins speakers, sends a hardened system prompt and a labeled transcript', async () => {
    const catalog = await makeCatalog('alice', 'bob');
    const clock = fakeClock();
    const { provider, calls } = mockProvider([distinctReply(0), distinctReply(1), distinctReply(2), distinctReply(3)], clock.advance);
    const result = await runner(catalog, provider, { now: clock.now, maxTurns: 4 }).run({ characterIds: ['alice', 'bob'], topic: 'the best kind of tea' });

    expect(result.stopReason).toBe('max_turns');
    expect(result.turns).toHaveLength(4);
    expect(result.turns.map((t) => t.speakerId)).toEqual(['alice', 'bob', 'alice', 'bob']);
    expect(result.turns.map((t) => t.speakerName)).toEqual(['ALICE', 'BOB', 'ALICE', 'BOB']);
    expect(result.turns[0]!.content).toBe(distinctReply(0));
    expect(result.turns.every((t) => typeof t.at === 'number' && t.at >= 0)).toBe(true);
    expect(result.totalMs).toBeGreaterThan(0);
    expect(result.error).toBeUndefined();
    expect(calls).toHaveLength(4);

    const [system, user] = calls[0]!.messages;
    expect(system!.role).toBe('system');
    expect(system!.content).toContain('sandbox');
    expect(system!.content).toContain('fictional personas');
    expect(system!.content).toContain('no live users');
    expect(system!.content).toContain('ALICE');
    expect(system!.content).toContain('BOB');
    expect(system!.content).toContain('Write the next turn as ALICE');
    expect(user!.role).toBe('user');
    expect(user!.content).toContain('Topic: the best kind of tea');
    expect(user!.content).toContain('(no turns yet');

    // Second call carries the transcript labeled by speaker name.
    expect(calls[1]!.messages[0]!.content).toContain('Write the next turn as BOB');
    const secondUser = calls[1]!.messages[1]!;
    expect(secondUser.content).toContain(`ALICE: ${distinctReply(0)}`);
    expect(secondUser.content).toContain('Now BOB, reply in character');

    const options = calls[0]!.options!;
    expect(options.task).toBe('admin');
    expect(options.temperature).toBe(0.7);
    expect(options.timeoutMs).toBe(20_000);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('rotates the speaking order with startWith', async () => {
    const catalog = await makeCatalog('alice', 'bob');
    const { provider, calls } = mockProvider([(i) => distinctReply(i)]);
    const result = await runner(catalog, provider, { maxTurns: 3 }).run({ characterIds: ['alice', 'bob'], topic: 'tea', startWith: 'bob' });
    expect(result.turns.map((t) => t.speakerId)).toEqual(['bob', 'alice', 'bob']);
    expect(calls[0]!.messages[0]!.content).toContain('Write the next turn as BOB');
    expect(result.stopReason).toBe('max_turns');
  });

  it('stops with completed when a turn ends with [END]', async () => {
    const catalog = await makeCatalog('alice', 'bob');
    const { provider } = mockProvider(['Let us begin the debate about tea.', 'I agree we have settled it.\n[END]', 'never reached']);
    const result = await runner(catalog, provider, { maxTurns: 8 }).run({ characterIds: ['alice', 'bob'], topic: 'tea' });
    expect(result.stopReason).toBe('completed');
    expect(result.turns).toHaveLength(2);
    expect(result.turns[1]!.content).toBe('I agree we have settled it.');
  });

  it('clamps maxTurns to the documented cap', async () => {
    const catalog = await makeCatalog('alice', 'bob');
    const { provider, calls } = mockProvider([(i) => distinctReply(i)]);
    const result = await runner(catalog, provider, { maxTurns: 100 }).run({ characterIds: ['alice', 'bob'], topic: 'tea' });
    expect(result.stopReason).toBe('max_turns');
    expect(result.turns).toHaveLength(CROSS_CHAT_LIMITS.maxTurnsCap);
    expect(calls).toHaveLength(CROSS_CHAT_LIMITS.maxTurnsCap);
  });

  it('truncates oversized replies to the turn cap', async () => {
    const catalog = await makeCatalog('alice', 'bob');
    const { provider } = mockProvider(['x'.repeat(3_000), 'y'.repeat(3_000)]);
    const result = await runner(catalog, provider, { maxTurns: 2 }).run({ characterIds: ['alice', 'bob'], topic: 'tea' });
    expect(result.turns.map((t) => t.content)).toEqual(['x'.repeat(CROSS_CHAT_LIMITS.turnChars), 'y'.repeat(CROSS_CHAT_LIMITS.turnChars)]);
  });
});

describe('CrossChatRunner loop guards', () => {
  it('stops on an exact duplicate within the repetition window', async () => {
    const catalog = await makeCatalog('alice', 'bob');
    const { provider, calls } = mockProvider([
      'Unique opening remark about the weather in spring.',
      'Unique response about autumn leaves falling slowly.',
      'Unique opening remark about the weather in spring.',
    ]);
    const result = await runner(catalog, provider, { maxTurns: 10 }).run({ characterIds: ['alice', 'bob'], topic: 'seasons' });
    expect(result.stopReason).toBe('repetition');
    expect(result.turns).toHaveLength(2);
    expect(calls).toHaveLength(3);
  });

  it('stops on a near-duplicate with high token overlap', async () => {
    const catalog = await makeCatalog('alice', 'bob');
    const { provider } = mockProvider([
      'the quick brown fox jumps over the lazy dog',
      'a totally different line about the sea and tall ships',
      'over the lazy dog the quick brown fox jumps',
    ]);
    const result = await runner(catalog, provider, { maxTurns: 10 }).run({ characterIds: ['alice', 'bob'], topic: 'pangrams' });
    expect(result.stopReason).toBe('repetition');
    expect(result.turns).toHaveLength(2);
  });

  it('repetitionWindow limits how far back duplicates are checked', async () => {
    const catalog = await makeCatalog('alice', 'bob');
    const { provider } = mockProvider([
      'First unique remark about mountains and cold winds.',
      'Second unique remark about oceans and warm tides.',
      'First unique remark about mountains and cold winds.',
    ]);
    const result = await runner(catalog, provider, { maxTurns: 3, repetitionWindow: 1 }).run({ characterIds: ['alice', 'bob'], topic: 'nature' });
    expect(result.stopReason).toBe('max_turns');
    expect(result.turns).toHaveLength(3);
  });

  it('records provider failure as an error stop without throwing', async () => {
    const catalog = await makeCatalog('alice', 'bob');
    const { provider, calls } = mockProvider(['A perfectly fine first reply.', new AIError('upstream exploded', { kind: 'server' })]);
    const result = await runner(catalog, provider, { maxTurns: 6 }).run({ characterIds: ['alice', 'bob'], topic: 'tea' });
    expect(result.stopReason).toBe('error');
    expect(result.error).toContain('upstream exploded');
    expect(result.turns).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it('records a per-call timeout as an error stop', async () => {
    const catalog = await makeCatalog('alice', 'bob');
    const hanging: AIProvider = {
      name: 'mock',
      model: 'mock-model',
      chat: (_messages, options) => new Promise((_resolve, reject) => {
        const abort = (): void => reject(new Error('aborted'));
        if (options?.signal?.aborted) abort();
        else options?.signal?.addEventListener('abort', abort, { once: true });
      }),
      health: async () => ({ ok: true }),
    };
    const result = await runner(catalog, hanging, { maxTurns: 4, timeoutMs: 120 }).run({ characterIds: ['alice', 'bob'], topic: 'tea' });
    expect(result.stopReason).toBe('error');
    expect(result.error).toContain('timeout after 120ms');
    expect(result.turns).toHaveLength(0);
  }, 10_000);

  it('records an empty reply as an error stop', async () => {
    const catalog = await makeCatalog('alice', 'bob');
    const { provider } = mockProvider(['   ']);
    const result = await runner(catalog, provider, { maxTurns: 4 }).run({ characterIds: ['alice', 'bob'], topic: 'tea' });
    expect(result.stopReason).toBe('error');
    expect(result.error).toBe('empty reply');
    expect(result.turns).toHaveLength(0);
  });
});

describe('CrossChatRunner input validation', () => {
  it('throws a clear error before any provider call', async () => {
    const catalog = await makeCatalog('alice', 'bob');
    const { provider, calls } = mockProvider(['never used']);
    const cross = runner(catalog, provider);

    await expect(cross.run({ characterIds: ['alice'], topic: 'tea' })).rejects.toMatchObject({ name: 'CrossChatError', code: 'input_invalid' });
    await expect(cross.run({ characterIds: ['alice', 'alice'], topic: 'tea' })).rejects.toBeInstanceOf(CrossChatError);
    await expect(cross.run({ characterIds: ['alice', 'alice.md'], topic: 'tea' })).rejects.toMatchObject({ code: 'input_invalid' });
    await expect(cross.run({ characterIds: ['alice', 'ghost'], topic: 'tea' })).rejects.toMatchObject({ code: 'character_not_found', message: 'unknown character: ghost' });
    await expect(cross.run({ characterIds: ['alice', 'bob'], topic: '   ' })).rejects.toMatchObject({ code: 'input_invalid' });
    await expect(cross.run({ characterIds: ['alice', 'bob'], topic: 'x'.repeat(501) })).rejects.toMatchObject({ code: 'input_invalid' });
    await expect(cross.run({ characterIds: ['alice', 'bob'], topic: 'tea\u0007party' })).rejects.toMatchObject({ code: 'input_invalid' });
    await expect(cross.run({ characterIds: ['alice', 'bob'], topic: 'tea', startWith: 'ghost' })).rejects.toMatchObject({ code: 'input_invalid' });

    expect(calls).toHaveLength(0);
  });
});
