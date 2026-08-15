import { describe, expect, it } from 'vitest';
import { AIConfigSchema, BotConfigSchema, MediaConfigSchema, MemoryConfigSchema, SessionConfigSchema } from '../config/schema.js';
import { EventBus } from '../core/event.js';
import { createNullLogger } from '../core/logger.js';
import type { MohoMessage, OutboundMessage } from '../core/types.js';
import { SessionManager } from '../session/manager.js';
import { MessagePipeline } from './pipeline.js';
import { ChatTraceStore } from './chat-trace.js';

const turns=[
 ['你好，我叫小岚。','你好，小岚。今天想从哪件事开始聊？'],
 ['我最近总是拖延。','先别急着责怪自己。你通常是卡在开始，还是卡在做一半？'],
 ['主要是任务一大就不敢打开。','那我们把它缩到五分钟：只打开任务，写下第一步，不要求完成。'],
 ['我有一份报告要写。','好，第一步可以只是列三个小标题。报告主题是什么？'],
 ['是关于社区志愿服务。','这个主题有温度。可以从背景、一次具体经历、你的收获三个标题起。'],
 ['我担心写得太空。','用一个真实细节把它落地：你见过的一个人、一句话，或一个场景。'],
 ['上次我帮一位老人学手机支付。','这就是很好的开头。写他一开始哪里不方便，后来成功时有什么反应。'],
 ['这样会不会太琐碎？','不会，具体才会让读者相信。琐碎的动作往往最能说明帮助发生过。'],
 ['我现在愿意打开文档了。','很好。只写三个标题和那段场景，写完就可以停。'],
 ['谢谢，我晚点把第一段给你看。','好，我等你带着第一段回来。先完成这个小动作就够了。'],
] as const;

describe('console chat acceptance transcript',()=>{
 it('runs ten consecutive console turns through pipeline, session and reply delivery',async()=>{
  const base=BotConfigSchema.parse({id:'console-acceptance',name:'墨染荷韵',rateLimit:{enabled:false},session:{persist:false,scope:'user'}});
  const media=MediaConfigSchema.parse(base.media);
  const config={...base,ai:AIConfigSchema.parse({...base.ai,apiKey:'test-key-123456'}),session:SessionConfigSchema.parse({...base.session,persist:false,scope:'user'}),memory:MemoryConfigSchema.parse(base.memory),media:{...media,vision:{...media.vision,apiKey:''},ocr:{...media.ocr,apiKey:''}}};
  const sessions=new SessionManager({botId:config.id,config:config.session,logger:createNullLogger()});
  const delivered:OutboundMessage[]=[]; const traces=new ChatTraceStore(); let reply=0;
  const provider={name:'console-acceptance',model:'deterministic-dialogue',async chat(messages:any[]){const last=messages.filter(m=>m.role==='user').at(-1)?.content;expect(last).toBe(turns[reply]?.[0]);const content=turns[reply++]![1];return{content,model:'deterministic-dialogue',ms:1};},async health(){return{ok:true};}};
  const pipeline=new MessagePipeline({config,provider,sessions,events:new EventBus(),logger:createNullLogger(),traces,send:async out=>{delivered.push(out);}});
  for(let i=0;i<turns.length;i++){const [user]=turns[i]!;const message:MohoMessage={id:`console-${i+1}`,platform:'console',botId:config.id,channel:{id:'console',dm:true},author:{id:'local-user',username:'小岚',bot:false},content:user,mentionsBot:true,attachments:[],createdAt:1_700_000_000_000+i};await pipeline.handle(message);}
  expect(reply).toBe(10);expect(delivered.map(x=>x.content)).toEqual(turns.map(x=>x[1]));
  const session=await sessions.get({botId:config.id,channelId:'console',userId:'local-user'});expect(session.messages).toHaveLength(20);expect(session.messages.map(m=>m.content)).toEqual(turns.flatMap(x=>[x[0],x[1]]));
  expect(traces.list()).toHaveLength(10);for(const trace of traces.list())expect(trace.events.map(e=>e.stage)).toEqual(expect.arrayContaining(['observed','context','model_started','model_completed','delivered']));
 });
});
