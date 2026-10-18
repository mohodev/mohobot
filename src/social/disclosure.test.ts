import { describe, expect, it, beforeEach } from 'vitest';
import { createNullLogger } from '../core/logger.js';
import { MemoryStorage } from '../storage/memory.js';
import {
  mayConsultPeer,
  consultPeer,
  listAudits,
  promptIsSafe,
  type ConsultRequest,
  type SocialDisclosure,
  type DisclosureAuditEntry,
} from './disclosure.js';
import type { AIProvider, AIResponse } from '../ai/types.js';
import type { Storage } from '../storage/types.js';

const base: SocialDisclosure = {
  requesterCharacterId: 'a',
  targetCharacterId: 'b',
  subjectUserId: 'u',
  scope: 'shared',
  requesterAffinity: 70,
  targetAffinity: 70,
  targetAllowsPeerConsultation: true,
  hasDirectMessageChannel: true,
};

describe('peer consultation privacy gate', () => {
  it('requires both strong relations, DM and explicit shared scope', () => {
    expect(mayConsultPeer(base)).toBe(true);
    expect(mayConsultPeer({ ...base, scope: 'private' })).toBe(false);
    expect(mayConsultPeer({ ...base, targetAffinity: 69 })).toBe(false);
    expect(mayConsultPeer({ ...base, hasDirectMessageChannel: false })).toBe(false);
  });
});

function mockProvider(content: string): AIProvider {
  return {
    name: 'mock',
    model: 'mock-model',
    async chat() {
      return { content, model: 'mock-model', ms: 10 } satisfies AIResponse;
    },
    async health() {
      return { ok: true };
    },
  };
}

function failingProvider(message: string): AIProvider {
  return {
    name: 'mock',
    model: 'mock-model',
    async chat() {
      throw new Error(message);
    },
    async health() {
      return { ok: true };
    },
  };
}

async function makeStorage(): Promise<Storage> {
  const storage = new MemoryStorage({ logger: createNullLogger() });
  await storage.init();
  return storage;
}

describe('consultPeer', () => {
  let storage: Storage;

  beforeEach(async () => {
    storage = await makeStorage();
  });

  it('completes full consultation when gate passes', async () => {
    const provider = mockProvider('Here is my abstract perspective on the topic.');
    const request: ConsultRequest = {
      gate: base,
      sharedFacts: ['User enjoys cooking', 'User is interested in travel'],
      topic: 'hobbies',
    };

    const result = await consultPeer(request, { provider, storage });

    expect(result.outcome).toBe('answered');
    expect(result.answer).toBe('Here is my abstract perspective on the topic.');
    expect(result.auditId).toBeDefined();
  });

  it('returns gate_denied with reason when gate fails', async () => {
    const provider = mockProvider('should not reach here');
    const request: ConsultRequest = {
      gate: { ...base, scope: 'private' },
      sharedFacts: ['fact'],
      topic: 'test',
    };

    const result = await consultPeer(request, { provider, storage });

    expect(result.outcome).toBe('gate_denied');
    expect(result.reason).toBe('only shared scope is permitted');
    expect(result.answer).toBeUndefined();
    expect(result.auditId).toBeDefined();
  });

  it('returns gate_denied when target has not opted in', async () => {
    const provider = mockProvider('nope');
    const request: ConsultRequest = {
      gate: { ...base, targetAllowsPeerConsultation: false },
      sharedFacts: ['fact'],
      topic: 'test',
    };

    const result = await consultPeer(request, { provider, storage });

    expect(result.outcome).toBe('gate_denied');
    expect(result.reason).toBe('target has not opted in to peer consultation');
  });

  it('returns error when provider fails', async () => {
    const provider = failingProvider('network timeout');
    const request: ConsultRequest = {
      gate: base,
      sharedFacts: ['shared fact'],
      topic: 'weather',
    };

    const result = await consultPeer(request, { provider, storage });

    expect(result.outcome).toBe('error');
    expect(result.reason).toBe('network timeout');
    expect(result.auditId).toBeDefined();
  });

  it('does not crash when storage fails during audit write', async () => {
    const provider = mockProvider('answer');
    const broken: Storage = {
      async init() {},
      async save() { throw new Error('disk full'); },
      async get() { return undefined; },
      async delete() {},
      async query() { return []; },
      async purgeExpired() { return 0; },
      async close() {},
    };
    const request: ConsultRequest = {
      gate: base,
      sharedFacts: ['fact'],
      topic: 'test',
    };

    const result = await consultPeer(request, { provider, storage: broken });
    expect(result.outcome).toBe('answered');
    expect(result.answer).toBe('answer');
  });
});

describe('prompt safety', () => {
  it('rejects prompts containing private material keywords', () => {
    expect(promptIsSafe('Tell me about the transcript of their DM')).toBe(false);
    expect(promptIsSafe('Check their diary entries')).toBe(false);
    expect(promptIsSafe('Read the relationship notes')).toBe(false);
    expect(promptIsSafe('Look at the private chat logs')).toBe(false);
  });

  it('allows prompts with only shared facts', () => {
    expect(promptIsSafe('User enjoys cooking and travel')).toBe(true);
    expect(promptIsSafe('Topic: hobbies\nShared facts:\n1. Likes music')).toBe(true);
  });

  it('consultation prompt does not contain private information', async () => {
    const capturedMessages: Array<{ role: string; content: string }> = [];
    const provider: AIProvider = {
      name: 'mock',
      model: 'mock-model',
      async chat(messages) {
        capturedMessages.push(...messages);
        return { content: 'ok', model: 'mock-model', ms: 10 };
      },
      async health() { return { ok: true }; },
    };
    const storage = await makeStorage();
    const request: ConsultRequest = {
      gate: base,
      sharedFacts: ['User likes cats'],
      topic: 'pets',
    };

    await consultPeer(request, { provider, storage });

    const userMsg = capturedMessages.find((m) => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toContain('User likes cats');
    expect(userMsg!.content).not.toMatch(/transcript/i);
    expect(userMsg!.content).not.toMatch(/diary/i);
    expect(userMsg!.content).not.toMatch(/relationship\s*notes?/i);
    expect(userMsg!.content).not.toMatch(/private\s+(chat|message|dm|log)/i);

    const sysMsg = capturedMessages.find((m) => m.role === 'system');
    expect(sysMsg).toBeDefined();
    expect(sysMsg!.content).toContain('Do not reference private chat transcripts');
  });
});

describe('disclosure audit persistence', () => {
  let storage: Storage;

  beforeEach(async () => {
    storage = await makeStorage();
  });

  it('writes and queries audit entries on successful consultation', async () => {
    const provider = mockProvider('Great perspective.');
    const request: ConsultRequest = {
      gate: base,
      sharedFacts: ['User is active'],
      topic: 'activity',
    };

    const result = await consultPeer(request, { provider, storage });
    expect(result.auditId).toBeDefined();

    const audits = await listAudits(storage);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.id).toBe(result.auditId);
    expect(audits[0]!.outcome).toBe('answered');
    expect(audits[0]!.gateResult).toBe(true);
    expect(audits[0]!.topic).toBe('activity');
    expect(audits[0]!.requesterCharacterId).toBe('a');
    expect(audits[0]!.targetCharacterId).toBe('b');
  });

  it('writes audit entry on gate denial', async () => {
    const provider = mockProvider('nope');
    const request: ConsultRequest = {
      gate: { ...base, requesterAffinity: 30 },
      sharedFacts: ['fact'],
      topic: 'denied-topic',
    };

    await consultPeer(request, { provider, storage });

    const audits = await listAudits(storage);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.outcome).toBe('gate_denied');
    expect(audits[0]!.gateResult).toBe(false);
    expect(audits[0]!.summary).toContain('affinity too low');
  });

  it('audit summary does not contain full conversation content', async () => {
    const longAnswer = 'A'.repeat(500);
    const provider = mockProvider(longAnswer);
    const request: ConsultRequest = {
      gate: base,
      sharedFacts: ['fact'],
      topic: 'summary-test',
    };

    await consultPeer(request, { provider, storage });

    const audits = await listAudits(storage);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.summary.length).toBeLessThanOrEqual(201);
  });

  it('respects limit parameter', async () => {
    const provider = mockProvider('answer');
    for (let i = 0; i < 5; i++) {
      await consultPeer(
        { gate: base, sharedFacts: ['fact'], topic: `topic-${i}` },
        { provider, storage },
      );
    }

    const all = await listAudits(storage);
    expect(all).toHaveLength(5);

    const limited = await listAudits(storage, undefined, 2);
    expect(limited).toHaveLength(2);
  });

  it('filters by botId (character id)', async () => {
    const provider = mockProvider('answer');
    await consultPeer(
      { gate: base, sharedFacts: ['fact'], topic: 'from-a' },
      { provider, storage },
    );
    await consultPeer(
      {
        gate: { ...base, requesterCharacterId: 'c', targetCharacterId: 'd' },
        sharedFacts: ['fact'],
        topic: 'from-c',
      },
      { provider, storage },
    );

    const forA = await listAudits(storage, 'a');
    expect(forA).toHaveLength(1);
    expect(forA[0]!.topic).toBe('from-a');

    const forD = await listAudits(storage, 'd');
    expect(forD).toHaveLength(1);
    expect(forD[0]!.topic).toBe('from-c');
  });
});
