import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { OpenAICompatibleProvider } from '../src/ai/openai-compatible.js';
import { MultiProviderRouter } from '../src/ai/multi-router.js';
import { PublicRelationshipStore, type PublicRelationship } from '../src/pipeline/public-relationships.js';
import { OpenAIEmbeddingProvider } from '../src/ai/embeddings.js';
import { AffinityStore } from '../src/admin/affinity.js';
import { DeviceStore } from '../src/admin/device.js';
import { WorldStore } from '../src/admin/world.js';
import { BotConfigSchema, MediaConfigSchema, MemoryConfigSchema, SessionConfigSchema, type AIConfig } from '../src/config/schema.js';
import { EventBus } from '../src/core/event.js';
import { createLogger } from '../src/core/logger.js';
import type { MohoMessage, OutboundMessage } from '../src/core/types.js';
import { SemanticMemoryAdapter } from '../src/memory/semantic-memory.js';
import { MessagePipeline } from '../src/pipeline/pipeline.js';
import { ChatTraceStore } from '../src/pipeline/chat-trace.js';
import { SessionManager } from '../src/session/manager.js';
import { SqliteStorage } from '../src/storage/sqlite.js';

const root=process.argv[2]??'/tmp/mohotest-persona';
const promptFile=process.argv[3]??'/tmp/moho-bot-prompt-audit/墨染荷韵_bot_prompt_v2.0.md';
const key=process.env.NVIDIA_NIM_API_KEY||'';
const kiloKey=process.env.KILO_API_KEY||'';
if(!key)throw new Error('NVIDIA_NIM_API_KEY is required for embeddings (environment only)');
if(!kiloKey)throw new Error('KILO_API_KEY is required for text chat (environment only)');
const chatModel=process.env.MOHOTEST_CHAT_MODEL||'poolside/laguna-s-2.1:free';
const embeddingModel=process.env.MOHOTEST_EMBED_MODEL||'nvidia/nemotron-3-embed-1b';
const chatBaseUrl=process.env.MOHOTEST_CHAT_BASE_URL||'https://api.kilo.ai/api/gateway/v1';
const embeddingBaseUrl='https://integrate.api.nvidia.com/v1';
const defaultTurns=[
 '在吗，我今天把一个 Node 服务跑起来了',
 '它能启动，但我有点担心日志把 token 打出来',
 '我已经加了脱敏和 ring buffer',
 '不过我老是拖着不写测试',
 '你记一下：我最在意的是升级时别丢 SQLite 数据',
 '顺便说一句，我喜欢茉莉花茶',
 '今天服务器的 world 状态怎么样？',
 '我把设备切成弱网会怎样',
 '刚才那条关于升级的事你还记得吗',
 '如果我明天回来问，长期记忆会保住吗',
 '我想给 MohoBot 加一个聊天调试台',
 '但不想把用户私密消息暴露在 WebUI',
 '你觉得先做 trace 还是先做知识库',
 '我有点累了，写代码写到现在',
 '别给我讲大道理，随便陪我说两句',
 '好吧，我去泡杯茉莉花茶',
 '回来啦，茶还挺香的',
 '我刚才决定先把 trace 做完',
 '再确认一下，我最在意的升级原则是什么？',
 '谢谢，今晚先收工，明天继续',
];
const transcript:string[]=[];
const operatorId=process.env.MOHOTEST_OPERATOR_ID||'operator-chatgpt';
const operatorName=process.env.MOHOTEST_OPERATOR_NAME||'ChatGPT';
const botDisplayName=process.env.MOHOTEST_BOT_NAME||'moho';
type TestTurn={content:string;authorId?:string;authorName?:string;channelId?:string;dm?:boolean;mentionsBot?:boolean};
const suppliedTurns:unknown=process.env.MOHOTEST_TURNS_JSON?JSON.parse(process.env.MOHOTEST_TURNS_JSON):defaultTurns;
if(!Array.isArray(suppliedTurns)||!suppliedTurns.every(x=>typeof x==='string'||(x&&typeof x==='object'&&typeof (x as TestTurn).content==='string')))throw new Error('MOHOTEST_TURNS_JSON must be a JSON string array or turn objects');
const turns:TestTurn[]=suppliedTurns.map(x=>typeof x==='string'?{content:x}:{...(x as TestTurn)});
const publicRelationships:PublicRelationship[]=process.env.MOHOTEST_PUBLIC_RELATIONSHIPS?JSON.parse(process.env.MOHOTEST_PUBLIC_RELATIONSHIPS):[];
if(!Array.isArray(publicRelationships))throw new Error('MOHOTEST_PUBLIC_RELATIONSHIPS must be a JSON array');
async function main(){
 await fs.rm(root,{recursive:true,force:true});await fs.mkdir(root,{recursive:true});
 const persona=await fs.readFile(promptFile,'utf8');
 // The selected final artifact is intentionally used byte-for-byte. Do not
 // append, summarize, translate, or mix it with README/verify material.
 const systemPrompt=persona;
 const base=BotConfigSchema.parse({id:'mohotest',name:botDisplayName,adapter:'console',systemPrompt,rateLimit:{enabled:false},session:{persist:true,scope:'user',maxMessages:12,maxChars:2200},memory:{enabled:true,adapter:'semantic',options:{allowedScopes:['private'],channelDomains:{'console-dm':`dm:${operatorId}`}}}});
 const media=MediaConfigSchema.parse(base.media);
 const config={...base,ai:{...base.ai,provider:'openai-compatible',baseUrl:chatBaseUrl,apiKey:kiloKey,model:chatModel,temperature:.65,maxTokens:0,timeoutMs:90_000,retries:0,stream:false,fallbackReply:'稍等',options:{}} as AIConfig,session:SessionConfigSchema.parse(base.session),memory:MemoryConfigSchema.parse(base.memory),media:{...media,vision:{...media.vision,apiKey:''},ocr:{...media.ocr,apiKey:''}}};
 const logger=createLogger({name:'mohotest',level:'warn',pretty:false});
 const storage=new SqliteStorage({path:path.join(root,'mohotest.db'),logger});await storage.init();
 const embedding=new OpenAIEmbeddingProvider({baseUrl:embeddingBaseUrl,apiKey:key,model:embeddingModel,timeoutMs:60_000},logger);
 const memory=new SemanticMemoryAdapter({storage,logger,embedding,recallLimit:3,candidateLimit:20,channelDomain:id=>id==='console-dm'?`dm:${operatorId}`:`channel:${id}`,allowedScopes:()=>['private']});
 const sessions=new SessionManager({botId:config.id,config:config.session,storage,logger,memory});
 const provider=new MultiProviderRouter({logger,defaultProfile:'hy3',profiles:{hy3:{baseUrl:chatBaseUrl,apiKey:kiloKey,model:chatModel,maxTokens:0,timeoutMs:90_000,retries:0},step:{baseUrl:chatBaseUrl,apiKey:kiloKey,model:'stepfun/step-3.7-flash:free',maxTokens:0,timeoutMs:90_000,retries:0},laguna:{baseUrl:chatBaseUrl,apiKey:kiloKey,model:'poolside/laguna-s-2.1:free',maxTokens:0,timeoutMs:90_000,retries:0}},routes:{reply:{primary:'hy3',fallback:['step','laguna']},planner:{primary:'hy3',fallback:['step','laguna']},reflection:{primary:'hy3',fallback:['step','laguna']},profile:{primary:'hy3',fallback:['step','laguna']},world:{primary:'hy3',fallback:['step','laguna']},admin:{primary:'hy3',fallback:['step','laguna']}}});const traces=new ChatTraceStore();const delivered:OutboundMessage[]=[];
 const pipeline=new MessagePipeline({config,provider,sessions,events:new EventBus(),logger,traces,stateRoot:root,publicRelationships:new PublicRelationshipStore(publicRelationships),send:async out=>{delivered.push(out)}});
 const world=new WorldStore(root);const device=new DeviceStore(root);const affinity=new AffinityStore(root);
 const beforeWorld=await world.get();await world.tick();const afterWorld=await world.get();
 await device.transition({battery:37,network:'weak',activity:'coding',doNotDisturb:true,notificationCount:2});await affinity.adjust(config.id,operatorId,5,'helpful','MohoTest conversation');
 const selectedTurns=Number(process.env.MOHOTEST_TURNS??turns.length); if(!Number.isInteger(selectedTurns)||selectedTurns<1||selectedTurns>turns.length)throw new Error(`MOHOTEST_TURNS must be 1..${turns.length}`);
 const delayMs=Number(process.env.MOHOTEST_DELAY_MS??0);if(!Number.isFinite(delayMs)||delayMs<0||delayMs>120_000)throw new Error('MOHOTEST_DELAY_MS must be 0..120000');
 for(let i=0;i<selectedTurns;i++){
   if(i>0&&delayMs>0)await new Promise<void>(resolve=>setTimeout(resolve,delayMs));
   const turn=turns[i]!;const user=turn.content;const authorId=turn.authorId??operatorId;const authorName=turn.authorName??operatorName;const channelId=turn.channelId??'console-dm';const dm=turn.dm??true;const start=delivered.length;
   const message:MohoMessage={id:`console-${i+1}`,platform:'console',botId:config.id,channel:{id:channelId,dm},author:{id:authorId,username:authorName,bot:false},content:user,mentionsBot:turn.mentionsBot??true,attachments:[],createdAt:Date.now()};
   try{await pipeline.handle(message);const answer=delivered.slice(start).map(x=>x.content).join('');transcript.push(`[${authorName} @ ${channelId}] ${user}\n[${botDisplayName}] ${answer||'[no delivery]'}`);}catch(error){const detail=error instanceof Error?error.message:String(error);transcript.push(`[${authorName} @ ${channelId}] ${user}\n[${botDisplayName}] [pipeline error: ${detail}]`);}
 }
 const session=await sessions.get({botId:config.id,channelId:'console-dm',userId:operatorId});
 const sessionKeys=[...new Map(turns.slice(0,selectedTurns).map(turn=>{const key={channelId:turn.channelId??'console-dm',userId:turn.authorId??operatorId,dm:turn.dm??true};return[`${key.channelId}:${key.userId}`,key] as const;})).values()];
 const sessionSnapshots=await Promise.all(sessionKeys.map(key=>sessions.get({botId:config.id,channelId:key.channelId,userId:key.userId})));
 await sessions.flush();
 const postCheckErrors:string[]=[];let recalled=0;let records:Awaited<ReturnType<typeof storage.query>>=[];
 try{const restartMemory=new SemanticMemoryAdapter({storage,logger,embedding,recallLimit:3,candidateLimit:20,channelDomain:id=>id==='console-dm'?`dm:${operatorId}`:`channel:${id}`,allowedScopes:()=>['private']});recalled=(await restartMemory.recall({botId:config.id,channelId:'console-dm',userId:operatorId,query:'升级 SQLite 数据 茉莉花茶'})).length;}catch(error){postCheckErrors.push(`recall: ${error instanceof Error?error.message:String(error)}`);}
 try{records=await storage.query({prefix:'semantic-memory:mohotest:'});}catch(error){postCheckErrors.push(`storage: ${error instanceof Error?error.message:String(error)}`);}
 const traceRows=traces.list();const fallbackDeliveries=delivered.filter(row=>row.content==='[chat unavailable]').length;const report={chatModel,embeddingModel,turns:selectedTurns,deliveries:delivered.length,fallbackDeliveries,sessionMessages:session.messages.length,sessionCapacity:config.session.maxMessages,allSessions:sessionSnapshots.map((snapshot,index)=>({channelId:sessionKeys[index]!.channelId,userId:sessionKeys[index]!.userId,messages:snapshot.messages.length})),traces:traceRows.length,modelCompleted:traceRows.filter(trace=>trace.events.some(event=>event.stage==='model_completed')).length,modelFailed:traceRows.filter(trace=>trace.events.some(event=>event.stage==='model_failed')).length,semanticRecords:records.length,embeddedRecords:records.filter(r=>Array.isArray((r.value as any).vector)&&((r.value as any).vector as number[]).length>0).length,recalled,postCheckErrors,worldTickAdvanced:JSON.stringify(beforeWorld)!==JSON.stringify(afterWorld),device:await device.get(),affinity:await affinity.get(config.id,operatorId),transcript};
 await fs.writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2));await fs.writeFile(path.join(root,'transcript.txt'),transcript.join('\n\n')+'\n');
 console.log(JSON.stringify({chatModel,embeddingModel,turns:report.turns,deliveries:report.deliveries,sessionMessages:report.sessionMessages,traces:report.traces,semanticRecords:report.semanticRecords,embeddedRecords:report.embeddedRecords,recalled:report.recalled,postCheckErrors:report.postCheckErrors,worldTickAdvanced:report.worldTickAdvanced},null,2));
 await storage.close();
}
main().catch(error=>{console.error(error instanceof Error?error.stack:error);process.exitCode=1});
