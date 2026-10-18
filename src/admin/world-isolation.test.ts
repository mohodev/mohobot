import { afterEach, describe, expect, it } from 'vitest';
import { getWorldForBot, listDomains, recordTrace, queryTraces, resetIsolation } from './world-isolation.js';

afterEach(() => resetIsolation());

describe('world isolation', () => {
  it('shared strategy returns same domain for different bots', () => {
    const a = getWorldForBot('bot-a', undefined, 'shared');
    const b = getWorldForBot('bot-b', undefined, 'shared');
    expect(a.id).toBe(b.id);
    expect(a.id).toBe('world:shared');
  });

  it('default strategy is shared', () => {
    const domain = getWorldForBot('bot-x');
    expect(domain.strategy).toBe('shared');
    expect(domain.id).toBe('world:shared');
  });

  it('per-bot strategy isolates by botId', () => {
    const a = getWorldForBot('bot-a', undefined, 'per-bot');
    const b = getWorldForBot('bot-b', undefined, 'per-bot');
    expect(a.id).not.toBe(b.id);
    expect(a.id).toBe('world:bot-a');
    expect(b.id).toBe('world:bot-b');
  });

  it('per-channel strategy isolates by botId and channelId', () => {
    const a = getWorldForBot('bot-a', 'ch-1', 'per-channel');
    const b = getWorldForBot('bot-a', 'ch-2', 'per-channel');
    expect(a.id).not.toBe(b.id);
    expect(a.id).toBe('world:bot-a:ch-1');
  });

  it('per-bot strategy ignores channelId', () => {
    const a = getWorldForBot('bot-a', 'ch-1', 'per-bot');
    const b = getWorldForBot('bot-a', 'ch-2', 'per-bot');
    expect(a.id).toBe(b.id);
  });

  it('listDomains returns all created domains', () => {
    getWorldForBot('bot-a', undefined, 'per-bot');
    getWorldForBot('bot-b', undefined, 'per-bot');
    expect(listDomains()).toHaveLength(2);
  });

  it('returns same domain on repeated calls', () => {
    const first = getWorldForBot('bot-a', undefined, 'per-bot');
    const second = getWorldForBot('bot-a', undefined, 'per-bot');
    expect(first).toBe(second);
  });
});

describe('world trace', () => {
  it('records and queries trace entries', () => {
    const entry = recordTrace({
      domainId: 'world:shared',
      botId: 'bot-a',
      at: new Date().toISOString(),
      kind: 'tick',
      before: { energy: 0.65 },
      after: { energy: 0.60 },
    });
    expect(entry.id).toMatch(/^trace:/);
    const results = queryTraces({ botId: 'bot-a' });
    expect(results).toHaveLength(1);
    expect(results[0]!.kind).toBe('tick');
  });

  it('filters by domainId and kind', () => {
    recordTrace({ domainId: 'd1', botId: 'b1', at: '', kind: 'tick', before: {}, after: {} });
    recordTrace({ domainId: 'd1', botId: 'b1', at: '', kind: 'evolution', before: {}, after: {} });
    recordTrace({ domainId: 'd2', botId: 'b2', at: '', kind: 'tick', before: {}, after: {} });

    expect(queryTraces({ domainId: 'd1' })).toHaveLength(2);
    expect(queryTraces({ kind: 'tick' })).toHaveLength(2);
    expect(queryTraces({ domainId: 'd1', kind: 'tick' })).toHaveLength(1);
  });

  it('respects limit', () => {
    for (let i = 0; i < 10; i++) {
      recordTrace({ domainId: 'd', botId: 'b', at: '', kind: 'event', before: {}, after: {} });
    }
    expect(queryTraces({ limit: 3 })).toHaveLength(3);
  });

  it('caps stored traces at max', () => {
    for (let i = 0; i < 2100; i++) {
      recordTrace({ domainId: 'd', botId: 'b', at: '', kind: 'tick', before: {}, after: {} });
    }
    expect(queryTraces({ limit: 3000 }).length).toBeLessThanOrEqual(2000);
  });
});
