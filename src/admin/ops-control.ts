import { createHash } from 'node:crypto';
import type { TaskInfo } from '../core/task-manager.js';
import { decodePersistedSession } from '../session/codec.js';
import type { Storage } from '../storage/types.js';

const SESSION_PREFIX='session:';const AUDIT_PREFIX='admin-audit:';const MAX_PAGE=100;
export interface PageInput{limit?:number;offset?:number;}
export interface SessionQuery extends PageInput{botId?:string;channelId?:string;userId?:string;}
export interface AuditQuery extends PageInput{actor?:string;action?:string;outcome?:'allowed'|'denied';method?:string;status?:number;from?:number;to?:number;}
export interface OpsPage<T>{items:T[];limit:number;offset:number;hasMore:boolean;}
export interface OpsSession{id:string;botId:string;channelId:string;userId?:string;updatedAt:number;messageCount:number;deletedCount:number;contentLength:number;summaryHash:string;}
export interface OpsAudit{id:string;at:string;actor:string;action:string;outcome:'allowed'|'denied';detail:string;method:string;path:string;status:number;}
export interface OpsTask{id:string;name:string;kind:TaskInfo['kind'];state:TaskInfo['state'];createdAt:number;startedAt?:number;finishedAt?:number;runs:number;errors:number;lastRunMs?:number;lastErrorCode?:string;}
export class OpsControlError extends Error{constructor(readonly code:'invalid_request'|'not_found'|'invalid_record'|'invalid_state',message:string=code){super(message);this.name='OpsControlError';}}
function object(v:unknown):v is Record<string,unknown>{return Boolean(v)&&typeof v==='object'&&!Array.isArray(v)}
function text(v:unknown,max=500):v is string{return typeof v==='string'&&v.length>0&&v.length<=max}
function finite(v:unknown):v is number{return typeof v==='number'&&Number.isFinite(v)}
function hash(v:string|Buffer):string{return createHash('sha256').update(v).digest('hex')}
function page(input:PageInput){const limit=input.limit??25,offset=input.offset??0;if(!Number.isSafeInteger(limit)||limit<1||limit>MAX_PAGE||!Number.isSafeInteger(offset)||offset<0)throw new OpsControlError('invalid_request','invalid pagination');return{limit,offset}}
function bounded(value:string|undefined,label:string){if(value!==undefined&&(!value.trim()||value.length>200))throw new OpsControlError('invalid_request',`invalid ${label}`);return value?.trim()}
function errorCode(value:string|undefined){return value?hash(value).slice(0,16):undefined}
function decodeAudit(value:unknown):OpsAudit|undefined{if(!object(value)||!text(value.id,200)||!text(value.at,100)||!text(value.actor,200)||!text(value.action,200)||!['allowed','denied'].includes(String(value.outcome))||typeof value.detail!=='string'||value.detail.length>2000||!text(value.method,20)||!text(value.path,1000)||!Number.isSafeInteger(value.status))return undefined;return value as unknown as OpsAudit;}
function taskView(task:TaskInfo):OpsTask{return{id:task.id,name:task.name,kind:task.kind,state:task.state,createdAt:task.createdAt,runs:task.runs,errors:task.errors,...(task.startedAt!==undefined?{startedAt:task.startedAt}:{}),...(task.finishedAt!==undefined?{finishedAt:task.finishedAt}:{}),...(task.lastRunMs!==undefined?{lastRunMs:task.lastRunMs}:{}),...(task.lastError?{lastErrorCode:errorCode(task.lastError)}:{})}}
export class OpsControlFacade{
 readonly #storage:Storage;readonly #tasks:()=>TaskInfo[];
 constructor(input:{storage:Storage;listTasks:()=>TaskInfo[]}){this.#storage=input.storage;this.#tasks=input.listTasks;}
 async listSessions(query:SessionQuery={}):Promise<OpsPage<OpsSession>>{const p=page(query),botId=bounded(query.botId,'botId'),channelId=bounded(query.channelId,'channelId'),userId=bounded(query.userId,'userId');const rows=await this.#storage.query<unknown>({prefix:botId?`${SESSION_PREFIX}${botId}:`:SESSION_PREFIX});const items:OpsSession[]=[];for(const row of rows){const decoded=decodePersistedSession(row.value,row.key);if(!decoded.ok)continue;const s=decoded.value;if(botId&&s.botId!==botId||channelId&&s.channelId!==channelId||userId&&s.userId!==userId)continue;const active=s.messages.filter(m=>!m.deleted);items.push({id:row.key,botId:s.botId,channelId:s.channelId,...(s.userId?{userId:s.userId}:{}),updatedAt:s.updatedAt,messageCount:s.messages.length,deletedCount:s.messages.length-active.length,contentLength:active.reduce((n,m)=>n+m.content.length,0),summaryHash:hash(active.map(m=>`${m.role}:${m.content}`).join('\n'))});}return this.#slice(items,p);}
 async deleteSession(id:string):Promise<boolean>{if(!text(id,1000)||!id.startsWith(SESSION_PREFIX))throw new OpsControlError('invalid_request','invalid session id');const value=await this.#storage.get<unknown>(id);if(value===undefined)throw new OpsControlError('not_found','session not found');if(!decodePersistedSession(value,id).ok)throw new OpsControlError('invalid_record','invalid session record');await this.#storage.delete(id);return true;}
 async listAudit(query:AuditQuery={}):Promise<OpsPage<OpsAudit>>{const p=page(query),actor=bounded(query.actor,'actor'),action=bounded(query.action,'action'),method=bounded(query.method,'method')?.toUpperCase();if(query.outcome!==undefined&&!['allowed','denied'].includes(query.outcome)||query.status!==undefined&&!Number.isSafeInteger(query.status)||query.from!==undefined&&!finite(query.from)||query.to!==undefined&&!finite(query.to))throw new OpsControlError('invalid_request','invalid audit filter');const rows=await this.#storage.query<unknown>({prefix:AUDIT_PREFIX});const items=rows.map(r=>decodeAudit(r.value)).filter((v):v is OpsAudit=>Boolean(v)).filter(v=>(!actor||v.actor===actor)&&(!action||v.action===action)&&(!method||v.method===method)&&(!query.outcome||v.outcome===query.outcome)&&(query.status===undefined||v.status===query.status)&&(query.from===undefined||Date.parse(v.at)>=query.from)&&(query.to===undefined||Date.parse(v.at)<=query.to));return this.#slice(items,p);}
 listTasks(input:PageInput={}):OpsPage<OpsTask>{const p=page(input);return this.#slice(this.#tasks().map(taskView),p);}
 #slice<T>(items:T[],p:{limit:number;offset:number}):OpsPage<T>{return{items:items.slice(p.offset,p.offset+p.limit),limit:p.limit,offset:p.offset,hasMore:items.length>p.offset+p.limit};}
}
