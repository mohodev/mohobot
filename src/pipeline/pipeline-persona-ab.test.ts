/**
 * Pipeline integration for persona A/B evaluation.
 *
 * The contract under test: a sampled DM turn generates both candidates from
 * the same prepared input, delivers the notice + card through the raw sender
 * (never through reply-plan parsing), continues the chat with the context-side
 * candidate, and never runs a second normal model call for the same turn.
 * `?ab` voting works for the record owner without admin rights.
 */

import { describe, expect, it, vi } from 'vitest';

import { AIConfigSchema, BotConfigSchema, MediaConfigSchema, MemoryConfigSchema, SessionConfigSchema } from '../config/schema.js';
import { EventBus } from '../core/event.js';
import { createNullLogger } from '../core/logger.js';
import type { ChatMessage } from '../core/types.js';
import type { SessionManagerLike } from '../session/types.js';
import { MessagePipeline, type PersonaAbBridge } from './pipeline.js';
import type { AbSide, PersonaAbRecord, PersonaSnapshot } from './persona-ab.js';
import { TopicBuffer } from './topic-buffer.js';

const BASE_PERSONA = '你是洛天依（线上版）';
const TEST_PERSONA = '你是洛天依（测试版）';

function snapshots(): { baseline: PersonaSnapshot; test: PersonaSnapshot } {
  return {
    baseline: { id: 'base.txt', label: 'base.txt', content: BASE_PERSONA, hash: 'h-base' },
    test: { id: 'test.txt', label: 'test.txt', content: TEST_PERSONA, hash: 'h-test' },
  };
}

/** Fake bridge: reserves exactly once per user, then stays quiet. */
function fakeAb(outcome: { reserve?: boolean; sendsOk?: boolean } = {}) {
  const { reserve = true, sendsOk = true } = outcome;
  const sent: string[] = [];
  const records = new Map<string, PersonaAbRecord>();
  let seq = 0;
  const bridge: PersonaAbBridge & { sent: string[]; records: Map<string, PersonaAbRecord> } = {
    sent,
    records,
    async reserve(input) {
      if (!reserve || records.has(input.userId)) return null;
      seq += 1;
      const record: PersonaAbRecord = {
        id: `rec-${seq}`,
        botId: 'main',
        userId: input.userId,
        sourceMessageId: input.sourceMessageId,
        contextSide: input.contextSide,
        personas: { baseline: input.baseline, test: input.test },
        mapping: { A: 'baseline', B: 'test' },
        createdAt: 1,
        expiresAt: 9_999_999_999,
        state: 'generating',
        candidates: {},
        generationErrors: {},
        vote: null,
        votedAt: null,
        switch: null,
        exposedAt: null,
        endedAt: null,
        delivery: null,
      };
      records.set(input.userId, record);
      return record;
    },
    async evaluate(record, generate, opts) {
      const [a, b] = await Promise.all([
        generate(record.personas.baseline.content).catch(() => undefined),
        generate(record.personas.test.content).catch(() => undefined),
      ]);
      if (a === undefined || b === undefined) return { reply: '', exposed: false, aborted: false };
      record.candidates = { baseline: a, test: b };
      const send = opts?.send ?? (async (c: string) => { sent.push(c); return sendsOk; });
      if (!(await send('notice'))) return { reply: '', exposed: false, aborted: false };
      const card = `A:${a}/B:${b}`;
      if (!(await send(card))) return { reply: a, exposed: false, aborted: false };
      record.state = 'pending';
      record.exposedAt = 2;
      return { reply: record.contextSide === 'baseline' ? a : b, exposed: true, aborted: false };
    },
    async snapshot(side: AbSide) {
      return side === 'baseline'
        ? { id: 'base.txt', label: 'base.txt', content: BASE_PERSONA, hash: 'h-base' }
        : { id: 'test.txt', label: 'test.txt', content: TEST_PERSONA, hash: 'h-test' };
    },
    async preference() { return null; },
    async loadVotable(userId: string) {
      const record = records.get(userId);
      return record && record.state === 'pending' ? record : null;
    },
    async vote(userId: string, _id: string | undefined, choice) {
      const record = records.get(userId);
      if (!record || record.state !== 'pending') throw new Error('no votable record');
      record.vote = choice;
      record.state = 'voted';
      return record;
    },
    async switchPersona(userId: string, _id: string, choice: 'A' | 'B') {
      const record = records.get(userId);
      if (!record) throw new Error('no record');
      record.switch = { choice, at: 3, side: record.mapping[choice] };
      return record;
    },
    async stats() {
      return { shown: 1, votes: 0, baselineWins: 0, testWins: 0, ties: 0, bothBad: 0, skipped: 0, expired: 0, failed: 0, responseRate: 0, notice: '' };
    },
  };
  return bridge;
}

function build(
  chat: (messages: ChatMessage[]) => Promise<string>,
  personaAb: PersonaAbBridge | undefined,
  opts: { dm?: boolean; systemPrompt?: string } = {},
) {
  // stream:true separates the normal call from candidate generation
  // (candidates always run non-streaming) in the assertions below.
  const base = BotConfigSchema.parse({ id: 'main', rateLimit: { enabled: false }, personaAb: { enabled: true } });
  const config = {
    ...base,
    systemPrompt: opts.systemPrompt ?? BASE_PERSONA,
    ai: AIConfigSchema.parse({ ...base.ai, apiKey: 'test-key-123456', maxTokens: 0, stream: true }),
    session: SessionConfigSchema.parse({ ...base.session, persist: false }),
    memory: MemoryConfigSchema.parse(base.memory),
    media: (() => { const media = MediaConfigSchema.parse(base.media); return { ...media, vision: { ...media.vision, apiKey: '' }, ocr: { ...media.ocr, apiKey: '' } }; })(),
  };
  const appended: ChatMessage[] = [];
  const sessions: SessionManagerLike = {
    async get() { return { key: 'k', botId: 'main', channelId: 'c', userId: 'u', messages: [], updatedAt: 0 }; },
    async append(_key, message) { appended.push(message); },
    async buildContext(_key, systemPrompt) { return [{ role: 'system', content: systemPrompt }, ...appended]; },
    async clear() {}, async sweep() { return 0; }, size() { return 1; },
  };
  const candidateInputs: ChatMessage[][] = [];
  const normalCalls: ChatMessage[][] = [];
  const outgoing: string[] = [];
  let seq = 0;
  const pipeline = new MessagePipeline({
    config, sessions, personaAb,
    topicBuffer: new TopicBuffer({ quietMs: 5 }),
    provider: {
      name: 'test', model: 'test',
      async chat(messages, options) {
        // Candidate generation runs non-streaming; the normal call streams.
        if (options?.stream === false) candidateInputs.push(messages);
        else normalCalls.push(messages);
        return { content: await chat(messages), model: 'test', ms: 0 };
      },
      async health() { return { ok: true }; },
    },
    events: new EventBus(), logger: createNullLogger(), send: async (out) => { outgoing.push(out.content); },
  });
  return {
    pipeline,
    candidateInputs,
    normalCalls,
    outgoing,
    async run(content: string, userId = 'u') {
      seq += 1;
      await pipeline.handle({
        id: `m-${seq}`, platform: 'discord', botId: 'main', channel: { id: 'c', dm: opts.dm ?? true },
        author: { id: userId, username: 'user', bot: false }, content, mentionsBot: true,
        attachments: [], createdAt: seq,
      });
    },
  };
}

describe('pipeline persona-ab integration', () => {
  it('evaluates a sampled DM with both personas and continues with the context side', async () => {
    const bridge = fakeAb();
    const chat = vi.fn(async (messages: ChatMessage[]) => {
      const persona = messages.find((m) => m.role === 'system')?.content ?? '';
      return persona.includes('测试版') ? '测试回答' : '基线回答';
    });
    const harness = build(chat, bridge);
    await harness.run('你好呀');

    // Two candidate generations, same prepared input, persona swapped.
    expect(harness.candidateInputs).toHaveLength(2);
    const [first, second] = harness.candidateInputs;
    expect(first!.filter((m) => m.role !== 'system')).toEqual(second!.filter((m) => m.role !== 'system'));
    expect(first![0]!.content).not.toBe(second![0]!.content);
    // No normal single call happened for this turn.
    expect(harness.normalCalls).toHaveLength(0);
    // Notice + card went through the raw sender, chat reply through the plan.
    expect(harness.outgoing).toHaveLength(3);
    expect(harness.outgoing[0]).toBe('notice');
    expect(harness.outgoing[1]).toContain('A:基线回答/B:测试回答');
    expect(harness.outgoing[2]).toBe('基线回答');
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('answers normally when no evaluation is reserved', async () => {
    const bridge = fakeAb({ reserve: false });
    const harness = build(async () => '普通回答', bridge);
    await harness.run('你好');
    expect(harness.candidateInputs).toHaveLength(0);
    expect(harness.normalCalls).toHaveLength(1);
    expect(harness.outgoing).toEqual(['普通回答']);
  });

  it('never evaluates group messages', async () => {
    const bridge = fakeAb();
    const harness = build(async () => '群回答', bridge, { dm: false });
    await harness.run('大家好');
    expect(harness.candidateInputs).toHaveLength(0);
    expect(harness.normalCalls).toHaveLength(1);
    expect(harness.outgoing).toEqual(['群回答']);
  });

  it('falls back to the normal call when the evaluation fails over', async () => {
    const bridge = fakeAb({ reserve: false });
    const failing: PersonaAbBridge = {
      ...bridge,
      reserve: async () => null,
      evaluate: async () => ({ reply: '', exposed: false, aborted: false }),
    };
    const harness = build(async () => '兜底回答', failing);
    await harness.run('你好');
    expect(harness.normalCalls).toHaveLength(1);
    expect(harness.outgoing).toEqual(['兜底回答']);
  });

  it('uses the switched challenger persona for later normal turns', async () => {
    const bridge = fakeAb({ reserve: false });
    bridge.preference = async () => 'test';
    const seen: string[] = [];
    const harness = build(async (messages: ChatMessage[]) => {
      seen.push(messages.find((m) => m.role === 'system')?.content ?? '');
      return '好';
    }, bridge);
    await harness.run('你好');
    expect(seen[0]).toContain('测试版');
    expect(harness.outgoing).toEqual(['好']);
  });

  it('lets the record owner vote without admin rights', async () => {
    const bridge = fakeAb();
    const harness = build(async (messages: ChatMessage[]) => {
      const persona = messages.find((m) => m.role === 'system')?.content ?? '';
      return persona.includes('测试版') ? '测试回答' : '基线回答';
    }, bridge);
    await harness.run('你好呀', 'alice');
    expect(harness.outgoing).toHaveLength(3);
    await harness.run('?ab B', 'alice');
    expect(harness.outgoing[3]).toContain('已记录投票：B');
    expect(bridge.records.get('alice')?.vote).toBe('B');
  });

  it('rejects votes from users without a pending evaluation', async () => {
    const bridge = fakeAb({ reserve: false });
    const harness = build(async () => '嗯', bridge);
    await harness.run('?ab A', 'bob');
    expect(harness.outgoing[0]).toContain('没有可投票的评估');
  });

  it('answers ?ab with the pending evaluation status', async () => {
    const bridge = fakeAb();
    const harness = build(async () => '基线回答', bridge);
    await harness.run('你好', 'carol');
    expect(harness.outgoing).toHaveLength(3);
    await harness.run('?ab', 'carol');
    expect(harness.outgoing[3]).toContain('待投票');
    expect(harness.outgoing[3]).toContain('rec-1');
  });
});
