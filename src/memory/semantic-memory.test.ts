import { describe, expect, it } from 'vitest';

import { createNullLogger } from '../core/logger.js';
import type { ChatMessage } from '../core/types.js';
import { MemoryStorage } from '../storage/memory.js';
import type { Storage } from '../storage/types.js';
import {
  SemanticMemoryAdapter,
  type EmbeddingProvider,
  type MemoryScope,
  type RerankProvider,
  type SemanticMemoryRecord,
} from './semantic-memory.js';

const logger = createNullLogger();

function message(role: ChatMessage['role'], content: string): ChatMessage {
  return { role, content };
}

async function storage(): Promise<Storage> {
  const value = new MemoryStorage({ logger });
  await value.init();
  return value;
}

async function remember(adapter: SemanticMemoryAdapter, content: string, createdAt: number): Promise<void> {
  await adapter.remember({
    botId: 'bot',
    channelId: 'channel',
    userId: 'user',
    user: message('user', content),
    assistant: message('assistant', `reply to ${content}`),
  });
}

describe('SemanticMemoryAdapter', () => {
  it('persists source text before embedding and keeps it when embedding fails', async () => {
    const store = await storage();
    const embedding: EmbeddingProvider = {
      name: 'broken',
      model: 'broken-v1',
      async embed() {
        throw new Error('offline');
      },
    };
    const adapter = new SemanticMemoryAdapter({ storage: store, logger, embedding, now: () => 100 });

    await expect(remember(adapter, 'favorite tea is jasmine', 100)).resolves.toBeUndefined();
    const rows = await store.query<SemanticMemoryRecord>({ prefix: 'semantic-memory:' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value.text).toContain('favorite tea is jasmine');
    expect(rows[0]?.value.vector).toBeUndefined();

    const recalled = await adapter.recall({ botId: 'bot', channelId: 'channel', userId: 'user', query: 'jasmine tea' });
    expect(recalled[0]?.content).toContain('favorite tea is jasmine');
  });

  it('batches missing embeddings and uses optional reranking', async () => {
    const store = await storage();
    const batches: number[] = [];
    const embedding: EmbeddingProvider = {
      name: 'embedding',
      model: 'embedding-v1',
      async embed(input) {
        const rows = Array.isArray(input) ? input : [input];
        batches.push(rows.length);
        return rows.map((text) => text.includes('music') ? [1, 0] : [0, 1]);
      },
    };
    const reranker: RerankProvider = {
      name: 'reranker',
      async rerank({ documents }) {
        return documents.map((_document, index) => ({ index, score: index })).reverse();
      },
    };
    let now = 100;
    const writer = new SemanticMemoryAdapter({ storage: store, logger, now: () => now });
    await remember(writer, 'likes music', 100);
    now = 200;
    await remember(writer, 'likes hiking', 200);
    now = 300;
    await remember(writer, 'concert music plans', 300);
    const adapter = new SemanticMemoryAdapter({
      storage: store,
      logger,
      embedding,
      reranker,
      recallLimit: 2,
      embeddingBatchSize: 2,
    });

    const recalled = await adapter.recall({ botId: 'bot', channelId: 'channel', userId: 'user', query: 'music' });
    expect(batches).toEqual([1, 2, 1]);
    expect(recalled).toHaveLength(2);
    expect(recalled[0]?.content).toContain('likes hiking');
    const rows = await store.query<SemanticMemoryRecord>({ prefix: 'semantic-memory:' });
    expect(rows.every(({ value }) => value.vector?.length === 2)).toBe(true);
  });

  it('filters privacy scopes before embedding and retrieval', async () => {
    const store = await storage();
    let scope: MemoryScope = 'private';
    const embeddedTexts: string[] = [];
    const embedding: EmbeddingProvider = {
      name: 'embedding',
      model: 'embedding-v1',
      async embed(input) {
        const rows = Array.isArray(input) ? input : [input];
        embeddedTexts.push(...rows);
        return rows.map(() => [1, 0]);
      },
    };
    let now = 100;
    const writer = new SemanticMemoryAdapter({ storage: store, logger, scopeForExchange: () => scope, now: () => now });
    await remember(writer, 'private secret', 100);
    scope = 'relationship';
    now = 200;
    await remember(writer, 'relationship detail', 200);
    scope = 'shared';
    now = 300;
    await remember(writer, 'shared hobby', 300);

    const adapter = new SemanticMemoryAdapter({
      storage: store,
      logger,
      embedding,
      allowedScopes: () => ['shared'],
      channelDomain: (channelId) => channelId === 'other' || channelId === 'channel' ? 'guild:g' : `dm:${channelId}`,
    });
    const recalled = await adapter.recall({ botId: 'bot', channelId: 'other', userId: 'user', query: 'hobby' });

    expect(recalled).toHaveLength(1);
    expect(recalled[0]?.content).toContain('shared hobby');
    expect(embeddedTexts.join('\n')).not.toContain('private secret');
    expect(embeddedTexts.join('\n')).not.toContain('relationship detail');
  });

  it('never recalls private or relationship memory across channels and separates DM/group domains', async()=>{const store=await storage();let scope:MemoryScope='private',now=1;const writer=new SemanticMemoryAdapter({storage:store,logger,scopeForExchange:()=>scope,now:()=>now});await writer.remember({botId:'bot',channelId:'guild-a',userId:'user',user:message('user','private guild'),assistant:message('assistant','p')});scope='relationship';now=2;await writer.remember({botId:'bot',channelId:'guild-a',userId:'user',user:message('user','relationship guild'),assistant:message('assistant','r')});scope='shared';now=3;await writer.remember({botId:'bot',channelId:'guild-a',userId:'user',user:message('user','shared guild'),assistant:message('assistant','s')});const reader=new SemanticMemoryAdapter({storage:store,logger,allowedScopes:()=>['private','relationship','shared'],channelDomain:(id)=>id.startsWith('guild-')?'guild:g':`dm:${id}`});const guild=await reader.recall({botId:'bot',channelId:'guild-b',userId:'user',query:'guild'});expect(guild.map(x=>x.content).join('\n')).toContain('shared guild');expect(guild.map(x=>x.content).join('\n')).not.toContain('private guild');expect(guild.map(x=>x.content).join('\n')).not.toContain('relationship guild');expect(await reader.recall({botId:'bot',channelId:'dm-user',userId:'user',query:'guild'})).toEqual([]);});

  it('isolates memories by bot and user and falls back to recent records', async () => {
    const store = await storage();
    let now = 100;
    const adapter = new SemanticMemoryAdapter({ storage: store, logger, recallLimit: 2, now: () => now });
    await remember(adapter, 'older unrelated note', 100);
    now = 200;
    await remember(adapter, 'newer unrelated note', 200);
    await store.save('semantic-memory:other:someone:1:x', {
      id: 'x', botId: 'other', channelId: 'channel', userId: 'someone', scope: 'shared',
      text: 'must not leak', user: message('user', 'must not leak'),
      assistant: message('assistant', 'no'), createdAt: 300,
    } satisfies SemanticMemoryRecord);

    const recalled = await adapter.recall({ botId: 'bot', channelId: 'channel', userId: 'user', query: 'no keyword match' });
    expect(recalled).toHaveLength(2);
    expect(recalled[0]?.content).toContain('newer unrelated note');
    expect(recalled.map(({ content }) => content).join('\n')).not.toContain('must not leak');
  });
});
