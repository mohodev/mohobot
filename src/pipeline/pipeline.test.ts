/**
 * Regression tests for the live context anchor injection.
 *
 * These lock the fix for the bot having no sense of time or conversation
 * continuity: every AI call now gets a second system message carrying the
 * current Asia/Shanghai wall-clock, so the model can reference "today" /
 * relative times and stay grounded in the ongoing conversation.
 */

import { describe, expect, it, vi } from 'vitest';
import { AIConfigSchema, BotConfigSchema, MediaConfigSchema, MemoryConfigSchema, SessionConfigSchema } from '../config/schema.js';
import { EventBus } from '../core/event.js';
import { createNullLogger } from '../core/logger.js';
import type { MohoMessage } from '../core/types.js';
import type { SessionManagerLike } from '../session/types.js';
import { buildContextAnchor, MessagePipeline, type PipelineDeps } from './pipeline.js'
import { TopicBuffer } from './topic-buffer.js';
import { ChatTraceStore } from './chat-trace.js';

describe('MessagePipeline ordering', () => {
  it('persists source identity on the user turn', async () => {
    const base = BotConfigSchema.parse({ id: 'main', rateLimit: { enabled: false } });
    const config = {
      ...base,
      ai: AIConfigSchema.parse({ ...base.ai, apiKey: 'test-key-123456', maxTokens: 0, stream: true }),
      session: SessionConfigSchema.parse({ ...base.session, persist: false }),
      memory: MemoryConfigSchema.parse(base.memory),
      media: (()=>{const media=MediaConfigSchema.parse(base.media);return{...media,vision:{...media.vision,apiKey:''},ocr:{...media.ocr,apiKey:''}}})(),
    };
    const appended: Array<import('../core/types.js').ChatMessage> = [];
    const sessions: SessionManagerLike = {
      async get() { return { key: 'k', botId: 'main', channelId: 'c', userId: 'u', messages: appended, updatedAt: 0 }; },
      async append(_key, message) { appended.push(message); },
      async buildContext(_key, systemPrompt) { return [{ role: 'system', content: systemPrompt }, ...appended]; },
      async clear() {}, async sweep() { return 0; }, size() { return 1; },
    };
    const outgoing: Array<import('../core/types.js').OutboundMessage> = [];
    const first = '第一句。';
    const second = '尾句。';
    const full = `\`\`\`reply-plan\n{"action":"reply","style":"chat","quote":true,"segments":[{"text":"${first}","pauseAfterMs":0},{"text":"${second}"}]}\n\`\`\``;
    const traces = new ChatTraceStore();
    const pipeline = new MessagePipeline({
      config,
      topicBuffer: new TopicBuffer({ quietMs: 5 }),
      provider: { name: 'test', model: 'test', async chat(_messages, options) { options?.onDelta?.(full.slice(0, 80)); options?.onDelta?.(full.slice(80)); return { content: full, model: 'test', ms: 0 }; }, async health() { return { ok: true }; } },
      sessions, events: new EventBus(), logger: createNullLogger(), traces, send: async (out) => { outgoing.push(out); },
    });
    await pipeline.handle({
      id: 'source-42', platform: 'discord', botId: 'main', channel: { id: 'c', dm: false },
      author: { id: 'u', username: 'user', bot: false }, content: 'hello', mentionsBot: true,
      attachments: [], createdAt: 1234,
    });
    expect(appended[0]).toMatchObject({
      role: 'user', content: 'hello', sourceMessageId: 'source-42', sourcePlatform: 'discord', createdAt: 1234,
    });
    expect(outgoing).toHaveLength(2);
    expect(outgoing[0]).toMatchObject({ content: first, replyToId: 'source-42' });
    expect(outgoing[1]).toMatchObject({ content: second });
    expect(traces.list()[0]?.events.map((event) => event.stage)).toEqual(expect.arrayContaining(['observed','context','model_started','delta','model_completed','plan_parsed','delivered','memory_written']));
  });

  it('shows typing while a direct model request is still pending', async () => {
    const base=BotConfigSchema.parse({id:'main',rateLimit:{enabled:false},discord:{typingIndicator:true}});const config={...base,ai:AIConfigSchema.parse({...base.ai,apiKey:'test-key',maxTokens:0}),session:SessionConfigSchema.parse({...base.session,persist:false}),memory:MemoryConfigSchema.parse(base.memory),media:{...MediaConfigSchema.parse(base.media),vision:{...MediaConfigSchema.parse(base.media).vision,apiKey:''},ocr:{...MediaConfigSchema.parse(base.media).ocr,apiKey:''}}};let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;});let typed=0;const sessions:SessionManagerLike={async get(){return{key:'k',botId:'main',channelId:'dm',userId:'u',messages:[],updatedAt:0};},async append(){},async buildContext(){return[{role:'user',content:'hi'}];},async clear(){},async sweep(){return 0;},size(){return 0;}};const pipeline=new MessagePipeline({config,sessions,topicBuffer:new TopicBuffer({quietMs:5}),provider:{name:'test',model:'test',async chat(){await waiting;return{content:'ok',model:'test',ms:1};},async health(){return{ok:true};}},events:new EventBus(),logger:createNullLogger(),typing:async()=>{typed++;},send:async()=>{}});const handled=pipeline.handle({id:'m',platform:'discord',botId:'main',channel:{id:'dm',dm:true},author:{id:'u',username:'u',bot:false},content:'hi',mentionsBot:true,attachments:[],createdAt:1});await vi.waitFor(()=>expect(typed).toBe(1));release();await handled;
  });

  it('interrupt & merge: a newer direct message supersedes the in-flight answer in the same session', async () => {
    const base = BotConfigSchema.parse({ id: 'main', rateLimit: { enabled: false } });
    const config = {
      ...base,
      ai: AIConfigSchema.parse({ ...base.ai, apiKey: 'test-key-123456', maxTokens: 0, stream: true }),
      session: SessionConfigSchema.parse({ ...base.session, persist: false, scope: 'user' }),
      memory: MemoryConfigSchema.parse(base.memory),
      media: { ...MediaConfigSchema.parse(base.media), vision: { ...MediaConfigSchema.parse(base.media).vision, apiKey: '' }, ocr: { ...MediaConfigSchema.parse(base.media).ocr, apiKey: '' } },
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
    const traces = new ChatTraceStore();
    const pipeline = new MessagePipeline({
      config,
      topicBuffer: new TopicBuffer({ quietMs: 5 }),
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
    // Let the batch window elapse so the newer turn flushes and marks the
    // in-flight generation as superseded. Per-key serialization means the
    // fresh call starts only after the first handle unwinds - so release it.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(calls).toEqual(['first']);
    releaseFirst?.();
    await Promise.all([first, second]);

    expect(calls).toEqual(['first', 'second']);
    // Hermes-style: the superseded answer never ships and never enters memory;
    // the session keeps both user turns followed by the single fresh reply.
    expect(sent).toEqual(['reply:second']);
    expect(history.map((m) => m.content)).toEqual(['first', 'second', 'reply:second']);
  });
});

describe('reply-plan ignore guard', () => {
  const ignorePlan = '```reply-plan\n{"action":"ignore","segments":[]}\n```';
  function ignoreSetup() {
    const base = BotConfigSchema.parse({ id: 'main', rateLimit: { enabled: false } });
    const config = {
      ...base,
      ai: AIConfigSchema.parse({ ...base.ai, apiKey: 'test-key-123456', maxTokens: 0, stream: false }),
      session: SessionConfigSchema.parse({ ...base.session, persist: false }),
      memory: MemoryConfigSchema.parse(base.memory),
      media: (()=>{const media=MediaConfigSchema.parse(base.media);return{...media,vision:{...media.vision,apiKey:''},ocr:{...media.ocr,apiKey:''}}})(),
    };
    const outgoing: Array<import('../core/types.js').OutboundMessage> = [];
    const traces = new ChatTraceStore();
    const pipeline = new MessagePipeline({
      config,
      topicBuffer: new TopicBuffer({ quietMs: 5 }),
      provider: { name: 'test', model: 'test', async chat() { return { content: ignorePlan, model: 'test', ms: 0 }; }, async health() { return { ok: true }; } },
      sessions: { async get() { return { key: 'k', botId: 'main', channelId: 'c', userId: 'u', messages: [], updatedAt: 0 }; }, async append() {}, async buildContext(_k, s) { return [{ role: 'system', content: s }]; }, async clear() {}, async sweep() { return 0; }, size() { return 0; } } as SessionManagerLike,
      events: new EventBus(), logger: createNullLogger(), traces, send: async (out) => { outgoing.push(out); },
    });
    return { pipeline, outgoing, traces };
  }
  it('overrides a model ignore plan when the user directly summoned the bot', async () => {
    const h = ignoreSetup();
    await h.pipeline.handle({ id: 'm1', platform: 'discord', botId: 'main', channel: { id: 'c', dm: false }, author: { id: 'u', username: 'user', bot: false }, content: '<@bot> 上线', mentionsBot: true, attachments: [], createdAt: 1 });
    expect(h.outgoing.length).toBeGreaterThan(0);
    expect(h.outgoing[0]!.content).toContain('在呢');
    expect(h.traces.list()[0]?.outcome).toBe('replied');
  });
  it('keeps silent skip for ordinary group chatter with no summons', async () => {
    const h = ignoreSetup();
    await h.pipeline.handle({ id: 'm2', platform: 'discord', botId: 'main', channel: { id: 'c', dm: false }, author: { id: 'u', username: 'user', bot: false }, content: '随便聊聊', mentionsBot: false, attachments: [], createdAt: 2 });
    expect(h.outgoing).toHaveLength(0);
    expect(h.traces.list()[0]?.events.some((e) => e.stage === 'ignored')).toBe(true);
  });
});

describe('interrupt & merge (Hermes-style)', () => {
  it('aborts an in-flight answer when a newer direct message arrives, then answers the merged turn', async () => {
    const base = BotConfigSchema.parse({ id: 'main', rateLimit: { enabled: false } });
    const config = {
      ...base,
      ai: AIConfigSchema.parse({ ...base.ai, apiKey: 'test-key-123456', maxTokens: 0, stream: false }),
      session: SessionConfigSchema.parse({ ...base.session, persist: false }),
      memory: MemoryConfigSchema.parse(base.memory),
      media: (()=>{const media=MediaConfigSchema.parse(base.media);return{...media,vision:{...media.vision,apiKey:''},ocr:{...media.ocr,apiKey:''}}})(),
    };
    const appended: Array<import('../core/types.js').ChatMessage> = [];
    const sessions: SessionManagerLike = {
      async get() { return { key: 'k', botId: 'main', channelId: 'c', userId: 'u', messages: appended, updatedAt: 0 }; },
      async append(_key, message) { appended.push(message); },
      async buildContext(_key, systemPrompt) { return [{ role: 'system', content: systemPrompt }, ...appended]; },
      async clear() {}, async sweep() { return 0; }, size() { return 1; },
    };
    let releaseFirst!: (v: { content: string; model: string; ms: number }) => void;
    const firstGate = new Promise<{ content: string; model: string; ms: number }>((resolve) => { releaseFirst = resolve; });
    const signals: AbortSignal[] = [];
    let calls = 0;
    const outgoing: Array<import('../core/types.js').OutboundMessage> = [];
    const traces = new ChatTraceStore();
    const pipeline = new MessagePipeline({
      config,
      topicBuffer: new TopicBuffer({ quietMs: 5 }),
      provider: {
        name: 'test', model: 'test',
        async chat(_messages, options) {
          calls += 1;
          if (calls === 1) { signals.push(options!.signal!); return firstGate; }
          return { content: '```reply-plan\n{"action":"reply","style":"chat","segments":[{"text":"合并后的回答"}]}\n```', model: 'test', ms: 0 };
        },
        async health() { return { ok: true }; },
      },
      sessions, events: new EventBus(), logger: createNullLogger(), traces, send: async (out) => { outgoing.push(out); },
    });
    const dm = (id: string, text: string): MohoMessage => ({ id, platform: 'discord' as const, botId: 'main', channel: { id: 'c', dm: true }, author: { id: 'u', username: 'user', bot: false }, content: text, mentionsBot: false, attachments: [], createdAt: Number(id) });
    const p1 = pipeline.handle(dm('1', '第一问'));
    await vi.waitFor(() => { expect(calls).toBe(1); });
    expect(signals[0]).toBeDefined();
    const p2 = pipeline.handle(dm('2', '等等，改成这样问'));
    // The newer direct message must abort the in-flight generation.
    await vi.waitFor(() => { expect(signals[0]!.aborted).toBe(true); });
    releaseFirst({ content: '```reply-plan\n{"action":"reply","style":"chat","segments":[{"text":"过时的回答"}]}\n```', model: 'test', ms: 0 });
    await Promise.all([p1, p2]);
    await vi.waitFor(() => { expect(calls).toBe(2); expect(outgoing).toHaveLength(1); });
    // The superseded answer is dropped; only the fresh merged answer ships.
    expect(outgoing[0]).toMatchObject({ content: '合并后的回答' });
    const firstTrace = traces.list().find((t) => t.messageId === '1');
    expect(firstTrace?.events.some((e) => e.stage === 'interrupted_previous')).toBe(false);
    expect(firstTrace?.events.some((e) => e.stage === 'aborted')).toBe(true);
    expect(firstTrace?.outcome).not.toBe('replied');
  });

  it('never interrupts for ordinary group chatter without a summons', async () => {
    const base = BotConfigSchema.parse({ id: 'main', rateLimit: { enabled: false } });
    const config = {
      ...base,
      ai: AIConfigSchema.parse({ ...base.ai, apiKey: 'test-key-123456', maxTokens: 0, stream: false }),
      session: SessionConfigSchema.parse({ ...base.session, persist: false }),
      memory: MemoryConfigSchema.parse(base.memory),
      media: (()=>{const media=MediaConfigSchema.parse(base.media);return{...media,vision:{...media.vision,apiKey:''},ocr:{...media.ocr,apiKey:''}}})(),
    };
    const signals: AbortSignal[] = [];
    let calls = 0;
    const gate = new Promise<void>(() => {});
    const traces = new ChatTraceStore();
    const pipeline = new MessagePipeline({
      config,
      topicBuffer: new TopicBuffer({ quietMs: 5 }),
      provider: { name: 'test', model: 'test', async chat(_m, o) { calls += 1; signals.push(o!.signal!); return gate as never; }, async health() { return { ok: true }; } },
      sessions: { async get() { return { key: 'k', botId: 'main', channelId: 'c', userId: 'u', messages: [], updatedAt: 0 }; }, async append() {}, async buildContext(_k, s) { return [{ role: 'system', content: s }]; }, async clear() {}, async sweep() { return 0; }, size() { return 0; } } as SessionManagerLike,
      events: new EventBus(), logger: createNullLogger(), traces, send: async () => {},
    });
    // '?' marks the message urgent in the social decision layer, so it always
    // reaches the model — yet carries no @/DM/reply summon, proving that the
    // interrupt path only fires for explicit direct summons.
    const group = (id: string): MohoMessage => ({ id, platform: 'discord' as const, botId: 'main', channel: { id: 'c', dm: false }, author: { id: 'u', username: 'user', bot: false }, content: `普通群聊问题${id}?`, mentionsBot: false, attachments: [], createdAt: Number(id) });
    void pipeline.handle(group('1'));
    // Ordinary chatter goes through the 900ms topic merge buffer first.
    await vi.waitFor(() => { expect(calls).toBe(1); }, { timeout: 3000 });
    void pipeline.handle(group('2'));
    await new Promise((r) => setTimeout(r, 50));
    expect(signals[0]!.aborted).toBe(false);
  });
});

describe('attachments', () => {
  it('keeps a safe attachment-only message in the AI context', async () => {
    const base = BotConfigSchema.parse({ id: 'main', rateLimit: { enabled: false } });
    const media=MediaConfigSchema.parse(base.media); const config = { ...base, ai: AIConfigSchema.parse(base.ai), session: SessionConfigSchema.parse({ ...base.session, persist: false }), memory: MemoryConfigSchema.parse(base.memory), media:{...media,vision:{...media.vision,apiKey:''},ocr:{...media.ocr,apiKey:''}} };
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

describe('media production wiring',()=>{
  const make=():MohoMessage=>({id:'m',platform:'console',botId:'main',channel:{id:'c',dm:true},author:{id:'u',username:'u',bot:false},content:'what is this?',mentionsBot:true,attachments:[{id:'a',url:'https://cdn.discordapp.com/a.png',name:'a.png',contentType:'image/png',size:2}],createdAt:0});
  const setup=(enabled:boolean,process?:PipelineDeps['media'])=>{const base=BotConfigSchema.parse({id:'main',rateLimit:{enabled:false}});const rawMedia=MediaConfigSchema.parse({...base.media,enabled});const config={...base,ai:AIConfigSchema.parse(base.ai),session:SessionConfigSchema.parse({...base.session,persist:false}),memory:MemoryConfigSchema.parse(base.memory),media:{...rawMedia,vision:{...rawMedia.vision,apiKey:enabled?'k':''},ocr:{...rawMedia.ocr,apiKey:''}}};let seen:Array<{role:string;content:string}>=[];let user='';const sessions:SessionManagerLike={async get(){return{key:'k',botId:'main',channelId:'c',messages:[],updatedAt:0};},async append(_k,m){if(m.role==='user')user=m.content;},async buildContext(){return[{role:'user',content:user}];},async clear(){},async sweep(){return 0;},size(){return 0;}};const pipeline=new MessagePipeline({config,media:process,provider:{name:'x',model:'x',async chat(messages){seen=messages;return{content:'ok',model:'x',ms:0};},async health(){return{ok:true};}},sessions,events:new EventBus(),logger:createNullLogger(),send:async()=>{}});return{pipeline,seen:()=>seen};};
  it('injects observations as an independent system message',async()=>{const media={process:vi.fn(async()=>({items:[{status:'observed'}],accepted:1,rejected:0,failed:0,context:'[media-observation] cat'}))};const h=setup(true,media as any);await h.pipeline.handle(make());expect(media.process).toHaveBeenCalledOnce();expect(h.seen().some(m=>m.role==='system'&&m.content.includes('[media-observation]'))).toBe(true);expect(h.seen().find(m=>m.role==='user')?.content).toContain('attachment_metadata');});
  it('falls back to metadata when observation fails',async()=>{const media={process:vi.fn(async()=>{throw new Error('offline');})};const h=setup(true,media as any);await h.pipeline.handle(make());expect(h.seen().some(m=>m.role==='system'&&m.content.includes('media-observation'))).toBe(false);expect(h.seen().find(m=>m.role==='user')?.content).toContain('attachment_metadata');});
  it('never calls media in zero-config mode',async()=>{const media={process:vi.fn(async()=>{throw new Error('must not run');})};const h=setup(false,media as any);await h.pipeline.handle(make());expect(media.process).not.toHaveBeenCalled();});
});

describe('persona messages', () => {
  it('treats ! text as ordinary chat instead of dispatching a command', async () => {
    const base = BotConfigSchema.parse({ id: 'main', rateLimit: { enabled: false } });
    const media=MediaConfigSchema.parse(base.media); const config = { ...base, ai: AIConfigSchema.parse(base.ai), session: SessionConfigSchema.parse({ ...base.session, persist: false }), memory: MemoryConfigSchema.parse(base.memory), media:{...media,vision:{...media.vision,apiKey:''},ocr:{...media.ocr,apiKey:''}} };
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
    const media=MediaConfigSchema.parse(base.media); const config = { ...base, ai: AIConfigSchema.parse(base.ai), session: SessionConfigSchema.parse({ ...base.session, persist: false }), memory: MemoryConfigSchema.parse(base.memory), media:{...media,vision:{...media.vision,apiKey:''},ocr:{...media.ocr,apiKey:''}} };
    const sessions: SessionManagerLike = { async get() { return { key: 'k', botId: 'admin', channelId: 'c', messages: [], updatedAt: 0 }; }, async append() {}, async buildContext() { return []; }, async clear() {}, async sweep() { return 0; }, size() { return 0; } };
    const sent: string[] = [];
    const pipeline = new MessagePipeline({ config, provider: { name: 'x', model: 'x', async chat() { throw new Error('must not call model'); }, async health() { return { ok: true }; } }, sessions, events: new EventBus(), logger: createNullLogger(), send: async (out) => { sent.push(out.content); } });
    const make = (author: string, isBotManager = false): MohoMessage => ({ id: author, platform: 'console', botId: 'admin', channel: { id: 'c', dm: true }, author: { id: author, username: author, bot: false, ...(isBotManager ? { isBotManager: true } : {}) }, content: '?status', mentionsBot: true, attachments: [], createdAt: 0 });
    await pipeline.handle(make('guest'));
    expect(sent).toEqual([]);
    await pipeline.handle(make('owner'));
    expect(sent).toEqual([]);
    await pipeline.handle(make('owner', true));
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
    const media=MediaConfigSchema.parse(base.media); const config = { ...base, ai:AIConfigSchema.parse(base.ai), session:SessionConfigSchema.parse({...base.session,persist:false}), memory:MemoryConfigSchema.parse(base.memory), media:{...media,vision:{...media.vision,apiKey:''},ocr:{...media.ocr,apiKey:''}} };
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
