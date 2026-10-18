import { describe, expect, it } from 'vitest';
import { createNullLogger } from '../core/logger.js';
import { MemoryStorage } from '../storage/memory.js';
import { JargonMemory, buildJargonBlock, validEntry, type JargonEntry } from './jargon-memory.js';

const logger = createNullLogger();

async function fixture(opts?: { minOccurrences?: number; now?: number }) {
  const now = opts?.now ?? 1_000_000;
  const storage = new MemoryStorage({ logger });
  await storage.init();
  return {
    storage,
    jargon: new JargonMemory({
      storage,
      logger,
      now: () => now,
      minOccurrences: opts?.minOccurrences ?? 3,
    }),
  };
}

const msg = (content: string, authorId = 'user-a', channelId = 'ch-1', guildId = 'guild-1') => ({
  content,
  authorId,
  channelId,
  guildId,
});

describe('JargonMemory.capture', () => {
  it('detects quoted definitions and creates candidates', async () => {
    const { jargon } = await fixture();
    await jargon.capture(msg('我们说的「摸鱼」就是摸鱼划水的意思'));
    const entries = await jargon.list({ status: 'candidate' });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.term).toBe('摸鱼');
    expect(entries[0]!.meaning).toContain('摸鱼划水');
    expect(entries[0]!.sourceAuthors).toEqual(['user-a']);
  });

  it('detects parenthetical definitions', async () => {
    const { jargon } = await fixture();
    await jargon.capture(msg('整活（就是搞事情）'));
    const entries = await jargon.list({ status: 'candidate' });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.term).toBe('整活');
    expect(entries[0]!.meaning).toBe('搞事情');
  });

  it('promotes frequency-tracked tokens when threshold is met by multiple authors', async () => {
    const { jargon } = await fixture({ minOccurrences: 2 });
    // First occurrence by user-a
    await jargon.capture(msg('今天又在摆烂了', 'user-a'));
    expect(await jargon.list({ status: 'candidate' })).toHaveLength(0);
    // Second occurrence by user-b -> threshold met with 2 authors
    await jargon.capture(msg('大家一起摆烂吧', 'user-b'));
    const entries = await jargon.list({ status: 'candidate' });
    // Some tokens may be promoted; check that at least one tracker reached threshold
    // The token '摆烂' should appear if it was extracted and tracked twice by 2 authors
    const found = entries.find((e) => e.term === '摆烂');
    expect(found).toBeDefined();
    expect(found!.sourceAuthors).toContain('user-a');
    expect(found!.sourceAuthors).toContain('user-b');
  });

  it('does not promote tokens from a single author', async () => {
    const { jargon } = await fixture({ minOccurrences: 2 });
    await jargon.capture(msg('摆烂摆烂', 'user-a'));
    await jargon.capture(msg('继续摆烂', 'user-a'));
    await jargon.capture(msg('还是摆烂', 'user-a'));
    const entries = await jargon.list({ status: 'candidate' });
    const found = entries.find((e) => e.term === '摆烂');
    // Should not be promoted because only one author
    expect(found).toBeUndefined();
  });

  it('updates existing candidate with new examples and authors', async () => {
    const { jargon } = await fixture();
    await jargon.capture(msg('「emo」就是情绪低落', 'user-a'));
    await jargon.capture(msg('「emo」就是很丧的感觉', 'user-b'));
    const entries = await jargon.list({ status: 'candidate' });
    const emo = entries.find((e) => e.term.toLowerCase() === 'emo');
    expect(emo).toBeDefined();
    expect(emo!.sourceAuthors).toContain('user-a');
    expect(emo!.sourceAuthors).toContain('user-b');
    expect(emo!.usageCount).toBe(2);
  });

  it('ignores empty or excessively long messages', async () => {
    const { jargon } = await fixture();
    await jargon.capture(msg(''));
    await jargon.capture(msg('x'.repeat(5000)));
    expect(await jargon.list()).toHaveLength(0);
  });
});

describe('JargonMemory.approve and reject', () => {
  it('approves a candidate and makes it recallable', async () => {
    const { jargon } = await fixture();
    await jargon.capture(msg('「摸鱼」就是摸鱼划水'));
    const candidates = await jargon.list({ status: 'candidate' });
    expect(candidates).toHaveLength(1);
    const id = candidates[0]!.id;

    const result = await jargon.approve(id, 'admin');
    expect(result).toBe('applied');

    const approved = await jargon.recall('ch-1', 'guild-1');
    expect(approved).toHaveLength(1);
    expect(approved[0]!.term).toBe('摸鱼');
    expect(approved[0]!.reviewer).toBe('admin');
  });

  it('returns unchanged for idempotent approve', async () => {
    const { jargon } = await fixture();
    await jargon.capture(msg('「gg」就是完蛋了'));
    const candidates = await jargon.list({ status: 'candidate' });
    const id = candidates[0]!.id;
    expect(await jargon.approve(id, 'admin')).toBe('applied');
    expect(await jargon.approve(id, 'admin')).toBe('unchanged');
  });

  it('rejects a candidate', async () => {
    const { jargon } = await fixture();
    await jargon.capture(msg('「水群」就是灌水闲聊'));
    const candidates = await jargon.list({ status: 'candidate' });
    const id = candidates[0]!.id;

    expect(await jargon.reject(id, 'admin')).toBe('applied');
    expect(await jargon.reject(id, 'admin')).toBe('unchanged');

    const recalled = await jargon.recall('ch-1', 'guild-1');
    expect(recalled).toHaveLength(0);
  });

  it('reports not-found for unknown ids', async () => {
    const { jargon } = await fixture();
    expect(await jargon.approve('missing', 'admin')).toBe('not-found');
    expect(await jargon.reject('missing', 'admin')).toBe('not-found');
  });
});

describe('JargonMemory.recall', () => {
  it('only returns approved entries for the matching group', async () => {
    const { jargon } = await fixture();
    await jargon.capture(msg('「摸鱼」就是摸鱼划水', 'u', 'ch-1', 'guild-1'));
    await jargon.capture(msg('「划水」就是不干活', 'u', 'ch-2', 'guild-2'));
    const candidates = await jargon.list({ status: 'candidate' });
    for (const c of candidates) await jargon.approve(c.id, 'admin');

    const guild1 = await jargon.recall('ch-1', 'guild-1');
    expect(guild1).toHaveLength(1);
    expect(guild1[0]!.term).toBe('摸鱼');

    const guild2 = await jargon.recall('ch-2', 'guild-2');
    expect(guild2).toHaveLength(1);
    expect(guild2[0]!.term).toBe('划水');
  });

  it('respects the recall limit', async () => {
    const { jargon } = await fixture();
    for (let i = 0; i < 5; i++) {
      await jargon.capture(msg(`「term${i}」就是意思${i}`, 'u', 'ch-1', 'guild-1'));
    }
    const candidates = await jargon.list({ status: 'candidate' });
    for (const c of candidates) await jargon.approve(c.id, 'admin');

    const recalled = await jargon.recall('ch-1', 'guild-1', 2);
    expect(recalled).toHaveLength(2);
  });
});

describe('JargonMemory.list', () => {
  it('filters by status, channel, and guild', async () => {
    const { jargon } = await fixture();
    await jargon.capture(msg('「A词」就是A义', 'u', 'ch-1', 'guild-1'));
    await jargon.capture(msg('「B词」就是B义', 'u', 'ch-2', 'guild-2'));
    const all = await jargon.list();
    expect(all).toHaveLength(2);

    const byChannel = await jargon.list({ channelId: 'ch-1' });
    expect(byChannel).toHaveLength(1);
    expect(byChannel[0]!.term).toBe('A词');

    const byGuild = await jargon.list({ guildId: 'guild-2' });
    expect(byGuild).toHaveLength(1);
    expect(byGuild[0]!.term).toBe('B词');

    const candidates = await jargon.list({ status: 'candidate' });
    expect(candidates).toHaveLength(2);
    expect(await jargon.list({ status: 'approved' })).toHaveLength(0);
  });

  it('supports offset and limit', async () => {
    const { jargon } = await fixture();
    for (let i = 0; i < 5; i++) {
      await jargon.capture(msg(`「t${i}」就是m${i}`, 'u', 'ch-1', 'guild-1'));
    }
    const page = await jargon.list({ offset: 2, limit: 2 });
    expect(page).toHaveLength(2);
  });
});

describe('buildJargonBlock', () => {
  it('produces a system message from approved entries', () => {
    const entries: JargonEntry[] = [
      { kind: 'jargon-memory', id: 'a', term: '摸鱼', meaning: '划水偷懒', examples: [], sourceAuthors: [], sharingGroup: {}, status: 'approved', confidence: 0.8, firstSeen: 1, lastSeen: 2, usageCount: 5 },
    ];
    const block = buildJargonBlock(entries);
    expect(block).toBeDefined();
    expect(block!.role).toBe('system');
    expect(block!.content).toContain('摸鱼');
    expect(block!.content).toContain('划水偷懒');
    expect(block!.content).toContain('群体黑话参考');
  });

  it('returns undefined for empty entries', () => {
    expect(buildJargonBlock([])).toBeUndefined();
  });

  it('respects maxChars', () => {
    const entries: JargonEntry[] = Array.from({ length: 100 }, (_, i) => ({
      kind: 'jargon-memory' as const, id: `${i}`, term: `长长长长长长长的黑话${i}`, meaning: `这是一个很长的解释来测试字符限制${i}`,
      examples: [], sourceAuthors: [], sharingGroup: {}, status: 'approved' as const, confidence: 0.8, firstSeen: 1, lastSeen: 2, usageCount: 5,
    }));
    const block = buildJargonBlock(entries, 100);
    expect(block).toBeDefined();
    expect(block!.content.length).toBeLessThanOrEqual(200); // header + constrained lines
  });
});

describe('validEntry', () => {
  it('accepts valid entries', () => {
    const entry: JargonEntry = {
      kind: 'jargon-memory', id: 'abc', term: '摸鱼', meaning: '划水', examples: ['摸鱼去'],
      sourceAuthors: ['u1'], sharingGroup: { channelId: 'ch' }, status: 'candidate',
      confidence: 0.5, firstSeen: 1, lastSeen: 2, usageCount: 1,
    };
    expect(validEntry(entry)).toBe(true);
  });

  it('rejects invalid data', () => {
    expect(validEntry(null)).toBe(false);
    expect(validEntry({})).toBe(false);
    expect(validEntry({ kind: 'jargon-memory' })).toBe(false);
    expect(validEntry({ kind: 'jargon-memory', id: '', term: '', meaning: '', examples: [], sourceAuthors: [], sharingGroup: {}, status: 'bad', confidence: 0, firstSeen: 0, lastSeen: 0, usageCount: 0 })).toBe(false);
  });
});
