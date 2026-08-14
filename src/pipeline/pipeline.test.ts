/**
 * Regression tests for the live context anchor injection.
 *
 * These lock the fix for the bot having no sense of time or conversation
 * continuity: every AI call now gets a second system message carrying the
 * current Asia/Shanghai wall-clock, so the model can reference "today" /
 * relative times and stay grounded in the ongoing conversation.
 */

import { describe, expect, it } from 'vitest';
import { AIConfigSchema, BotConfigSchema, MemoryConfigSchema, SessionConfigSchema } from '../config/schema.js';
import { EventBus } from '../core/event.js';
import { createNullLogger } from '../core/logger.js';
import type { MohoMessage } from '../core/types.js';
import type { SessionManagerLike } from '../session/types.js';
import { buildContextAnchor, MessagePipeline } from './pipeline.js';

describe('MessagePipeline ordering', () => {
  it('persists source identity on the user turn', async () => {
    const base = BotConfigSchema.parse({ id: 'main', rateLimit: { enabled: false } });
    const config = {
      ...base,
      ai: AIConfigSchema.parse({ ...base.ai, apiKey: 'test-key-123456' }),
      session: SessionConfigSchema.parse({ ...base.session, persist: false }),
      memory: MemoryConfigSchema.parse(base.memory),
    };
    const appended: Array<import('../core/types.js').ChatMessage> = [];
    const sessions: SessionManagerLike = {
      async get() { return { key: 'k', botId: 'main', channelId: 'c', userId: 'u', messages: appended, updatedAt: 0 }; },
      async append(_key, message) { appended.push(message); },
      async buildContext(_key, systemPrompt) { return [{ role: 'system', content: systemPrompt }, ...appended]; },
      async clear() {}, async sweep() { return 0; }, size() { return 1; },
    };
    const pipeline = new MessagePipeline({
      config,
      provider: { name: 'test', model: 'test', async chat() { return { content: 'ok', model: 'test', ms: 0 }; }, async health() { return { ok: true }; } },
      sessions, events: new EventBus(), logger: createNullLogger(), send: async () => {},
    });
    await pipeline.handle({
      id: 'source-42', platform: 'discord', botId: 'main', channel: { id: 'c', dm: true },
      author: { id: 'u', username: 'user', bot: false }, content: 'hello', mentionsBot: true,
      attachments: [], createdAt: 1234,
    });
    expect(appended[0]).toMatchObject({
      role: 'user', content: 'hello', sourceMessageId: 'source-42', sourcePlatform: 'discord', createdAt: 1234,
    });
  });

  it('serializes concurrent messages in the same user session', async () => {
    const base = BotConfigSchema.parse({ id: 'main', rateLimit: { enabled: false } });
    const config = {
      ...base,
      ai: AIConfigSchema.parse({ ...base.ai, apiKey: 'test-key-123456' }),
      session: SessionConfigSchema.parse({ ...base.session, persist: false, scope: 'user' }),
      memory: MemoryConfigSchema.parse(base.memory),
    };
    const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    const sessions: SessionManagerLike = {
      async get() { return { key: 'k', botId: 'main', channelId: 'c', userId: 'u', messages: history, updatedAt: Date.now() }; },
      async append(_key, message) { if (message.role !== 'system') history.push({ role: message.role, content: message.content }); },
      async buildContext(_key, systemPrompt) { return [{ role: 'system', content: systemPrompt }, ...history]; },
      async clear() { history.length = 0; },
      async sweep() { return 0; },
      size() { return 1; },
    };
    let releaseFirst: (() => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const calls: string[] = [];
    const provider = {
      name: 'test',
      model: 'test',
      async chat(messages: Array<{ role: string; content: string }>) {
        const users = messages.filter((m) => m.role === 'user');
        const prompt = users.at(-1)?.content ?? '';
        calls.push(prompt);
        if (prompt === 'first') {
          markFirstStarted?.();
          await firstBlocked;
        }
        return { content: `reply:${prompt}`, model: 'test', ms: 0 };
      },
      async health() { return { ok: true }; },
    };
    const sent: string[] = [];
    const pipeline = new MessagePipeline({
      config,
      provider,
      sessions,
      events: new EventBus(),
      logger: createNullLogger(),
      send: async (out) => { sent.push(out.content); },
    });
    const message = (id: string, content: string): MohoMessage => ({
      id,
      platform: 'console',
      botId: 'main',
      channel: { id: 'c', dm: true },
      author: { id: 'u', username: 'user', bot: false },
      content,
      mentionsBot: true,
      attachments: [],
      createdAt: Date.now(),
    });

    const first = pipeline.handle(message('1', 'first'));
    await firstStarted;
    const second = pipeline.handle(message('2', 'second'));
    await Promise.resolve();
    expect(calls).toEqual(['first']);
    releaseFirst?.();
    await Promise.all([first, second]);

    expect(calls).toEqual(['first', 'second']);
    expect(sent).toEqual(['reply:first', 'reply:second']);
    expect(history.map((m) => m.content)).toEqual(['first', 'reply:first', 'second', 'reply:second']);
  });
});

describe('attachments', () => {
  it('keeps a safe attachment-only message in the AI context', async () => {
    const base = BotConfigSchema.parse({ id: 'main', rateLimit: { enabled: false } });
    const config = { ...base, ai: AIConfigSchema.parse(base.ai), session: SessionConfigSchema.parse({ ...base.session, persist: false }), memory: MemoryConfigSchema.parse(base.memory) };
    let seen='';
    const sessions: SessionManagerLike = { async get() { return { key:'k',botId:'main',channelId:'c',messages:[],updatedAt:0 }; }, async append(_key,message) { if(message.role==='user')seen=message.content; }, async buildContext() { return [{ role:'user',content:seen }]; }, async clear(){}, async sweep(){return 0;}, size(){return 0;} };
    const sent:string[]=[];
    const pipeline=new MessagePipeline({config,provider:{name:'x',model:'x',async chat(){return{content:'看到了附件',model:'x',ms:0};},async health(){return{ok:true};}},sessions,events:new EventBus(),logger:createNullLogger(),send:async out=>{sent.push(out.content);}});
    await pipeline.handle({id:'1',platform:'console',botId:'main',channel:{id:'c',dm:true},author:{id:'u',username:'u',bot:false},content:'',mentionsBot:true,attachments:[{id:'a',url:'https://cdn.discordapp.com/a.png',name:'a.png',contentType:'image/png',size:123}],createdAt:0});
    expect(seen).toContain('image');
    expect(seen).not.toContain('cdn.discordapp.com');
    expect(sent).toEqual(['看到了附件']);
  });
});

describe('persona messages', () => {
  it('treats ! text as ordinary chat instead of dispatching a command', async () => {
    const base = BotConfigSchema.parse({ id: 'main', rateLimit: { enabled: false } });
    const config = { ...base, ai: AIConfigSchema.parse(base.ai), session: SessionConfigSchema.parse({ ...base.session, persist: false }), memory: MemoryConfigSchema.parse(base.memory) };
    const sessions: SessionManagerLike = { async get() { return { key: 'k', botId: 'main', channelId: 'c', messages: [], updatedAt: 0 }; }, async append() {}, async buildContext() { return [{ role: 'user', content: '!help me with this' }]; }, async clear() {}, async sweep() { return 0; }, size() { return 0; } };
    const sent: string[] = [];
    const pipeline = new MessagePipeline({ config, provider: { name: 'x', model: 'x', async chat(messages) { return { content: `heard:${messages.filter((m) => m.role === 'user').at(-1)?.content}`, model: 'x', ms: 0 }; }, async health() { return { ok: true }; } }, sessions, events: new EventBus(), logger: createNullLogger(), send: async (out) => { sent.push(out.content); } });
    await pipeline.handle({ id: '1', platform: 'console', botId: 'main', channel: { id: 'c', dm: true }, author: { id: 'u', username: 'u', bot: false }, content: '!help me with this', mentionsBot: true, attachments: [], createdAt: 0 });
    expect(sent).toEqual(['heard:!help me with this']);
  });
});

describe('admin ? commands', () => {
  it('only responds for the enabled administrator bot and allowlisted user', async () => {
    const base = BotConfigSchema.parse({ id: 'admin', admin: { enabled: true, userIds: ['owner'] }, rateLimit: { enabled: false } });
    const config = { ...base, ai: AIConfigSchema.parse(base.ai), session: SessionConfigSchema.parse({ ...base.session, persist: false }), memory: MemoryConfigSchema.parse(base.memory) };
    const sessions: SessionManagerLike = { async get() { return { key: 'k', botId: 'admin', channelId: 'c', messages: [], updatedAt: 0 }; }, async append() {}, async buildContext() { return []; }, async clear() {}, async sweep() { return 0; }, size() { return 0; } };
    const sent: string[] = [];
    const pipeline = new MessagePipeline({ config, provider: { name: 'x', model: 'x', async chat() { throw new Error('must not call model'); }, async health() { return { ok: true }; } }, sessions, events: new EventBus(), logger: createNullLogger(), send: async (out) => { sent.push(out.content); } });
    const make = (author: string): MohoMessage => ({ id: author, platform: 'console', botId: 'admin', channel: { id: 'c', dm: true }, author: { id: author, username: author, bot: false }, content: '?status', mentionsBot: true, attachments: [], createdAt: 0 });
    await pipeline.handle(make('guest'));
    expect(sent).toEqual([]);
    await pipeline.handle(make('owner'));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('管理状态');
  });
});

describe('buildContextAnchor', () => {
  it('emits a Beijing-time anchor carrying date, weekday and time', () => {
    const anchor = buildContextAnchor();
    expect(anchor).toContain('北京时间 UTC+8');
    // Date parts are present in zh-CN form (year/month/day/weekday/time).
    expect(anchor).toMatch(/\d{4}年/); // a year
    expect(anchor).toMatch(/\d{1,2}:\d{2}/); // HH:MM
    // A CJK weekday token such as 星期日 / 星期一 must appear.
    expect(anchor).toMatch(/[\u4e00-\u9fa5]{2,3}/);
  });

  it('instructs the model not to invent times and to use context', () => {
    const anchor = buildContextAnchor();
    expect(anchor).toContain('不要臆测日期或时刻');
    expect(anchor).toContain('记得用户刚才说过的内容');
  });

  it('does not echo any real credential or system internals', () => {
    const anchor = buildContextAnchor();
    expect(anchor).not.toMatch(/sk-|api[_-]?key|token/i);
  });
});

describe('thread/forum production session routing', () => {
  async function effectiveInput(kind: 'thread'|'forum-post', policy: 'isolated'|'inherit-parent') {
    const base = BotConfigSchema.parse({ id:'main', rateLimit:{enabled:false}, session: kind === 'thread' ? { threadContext: policy } : { forumContext: policy } });
    const config = { ...base, ai:AIConfigSchema.parse(base.ai), session:SessionConfigSchema.parse({...base.session,persist:false}), memory:MemoryConfigSchema.parse(base.memory) };
    let captured: {channelId:string}|undefined;
    const sessions: SessionManagerLike={async get(){return{key:'k',botId:'main',channelId:'x',messages:[],updatedAt:0};},async append(input){captured=input;},async buildContext(){return[{role:'user',content:'hello'}];},async clear(){},async sweep(){return 0;},size(){return 0;}};
    const pipeline=new MessagePipeline({config,sessions,provider:{name:'x',model:'x',async chat(){return{content:'ok',model:'x',ms:0};},async health(){return{ok:true};}},events:new EventBus(),logger:createNullLogger(),send:async()=>{}});
    const parent=kind==='thread'?'text1':'forum1';
    await pipeline.handle({id:'m',platform:'discord',botId:'main',channel:{id:'child1',guildId:'g1',dm:false,parentChannelId:parent,location:{channelId:'child1',parentChannelId:parent,guildId:'g1',kind}},author:{id:'u',username:'u',bot:false},content:'hello',mentionsBot:true,attachments:[],createdAt:1});
    return captured?.channelId;
  }
  it('isolates thread and forum post contexts',async()=>{expect(await effectiveInput('thread','isolated')).toBe('child1');expect(await effectiveInput('forum-post','isolated')).toBe('child1');});
  it('inherits parent context independently',async()=>{expect(await effectiveInput('thread','inherit-parent')).toBe('text1');expect(await effectiveInput('forum-post','inherit-parent')).toBe('forum1');});
});
