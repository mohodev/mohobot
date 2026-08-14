import { randomUUID } from 'node:crypto';
import type { EventBus } from './event.js';
import type { Logger } from './logger.js';

export type TaskState='pending'|'running'|'done'|'failed'|'cancelled'|'paused';
export type TaskKind='oneshot'|'interval';
export interface TaskHistoryEntry{at:number;outcome:'succeeded'|'failed'|'skipped';durationMs:number;errorCode?:string;}
export interface TaskInfo{id:string;name:string;kind:TaskKind;state:TaskState;createdAt:number;startedAt?:number;finishedAt?:number;runs:number;errors:number;lastError?:string;lastRunMs?:number;/** Added after the initial TaskInfo contract; absent means false for legacy projections. */paused?:boolean;/** Added after the initial TaskInfo contract; absent means no retained history. */history?:TaskHistoryEntry[];}
export interface TaskContext{signal:AbortSignal;taskId:string;name:string;}
export type TaskFn=(ctx:TaskContext)=>unknown|Promise<unknown>;
export interface SpawnOptions{name:string;intervalMs?:number;immediate?:boolean;timeoutMs?:number;continueOnError?:boolean;}
interface TaskEntry{info:TaskInfo;controller:AbortController;timer?:NodeJS.Timeout;inflight?:Promise<void>;fn:TaskFn;options:SpawnOptions;}
const HISTORY_LIMIT=32;
function errorCode(error:unknown):string{if(error instanceof Error){if(/timed out/i.test(error.message))return'timeout';if(error.name&&error.name!=='Error')return error.name.toLowerCase().replace(/[^a-z0-9]+/g,'_').slice(0,48)||'error';}return'error';}
/** Owns background work; registered task functions never cross the control-plane boundary. */
export class TaskManager{
 readonly #tasks=new Map<string,TaskEntry>();readonly #logger:Logger;readonly #events?:EventBus;#stopped=false;
 constructor(deps:{logger:Logger;events?:EventBus}){this.#logger=deps.logger.child({component:'tasks'});this.#events=deps.events;}
 spawn(fn:TaskFn,options:SpawnOptions):string{if(this.#stopped){this.#logger.warn({name:options.name},'task rejected: manager stopped');return'';}const id=randomUUID();const controller=new AbortController();const entry:TaskEntry={fn,options,controller,info:{id,name:options.name,kind:options.intervalMs&&options.intervalMs>0?'interval':'oneshot',state:'pending',createdAt:Date.now(),runs:0,errors:0,paused:false,history:[]}};this.#tasks.set(id,entry);if(entry.info.kind==='interval'){const ms=options.intervalMs!;entry.timer=setInterval(()=>void this.#run(entry),ms);entry.timer.unref?.();if(options.immediate)void this.#run(entry);}else void this.#run(entry);return id;}
 run<T>(name:string,fn:(ctx:TaskContext)=>Promise<T>,timeoutMs?:number):string{return this.spawn(fn as TaskFn,timeoutMs===undefined?{name}:{name,timeoutMs});}
 async runNow(id:string):Promise<boolean>{const entry=this.#tasks.get(id);if(!entry||entry.info.kind!=='interval'||entry.info.paused||entry.inflight)return false;await this.#run(entry);return true;}
 pause(id:string):boolean{const entry=this.#tasks.get(id);if(!entry||entry.info.kind!=='interval'||entry.info.paused)return false;entry.info.paused=true;entry.info.state='paused';return true;}
 resume(id:string):boolean{const entry=this.#tasks.get(id);if(!entry||entry.info.kind!=='interval'||!entry.info.paused||entry.controller.signal.aborted)return false;entry.info.paused=false;entry.info.state='pending';return true;}
 cancel(id:string):boolean{const entry=this.#tasks.get(id);if(!entry)return false;entry.controller.abort();if(entry.timer)clearInterval(entry.timer);entry.info.state='cancelled';entry.info.finishedAt=Date.now();this.#tasks.delete(id);return true;}
 cancelByName(name:string):number{let count=0;for(const [id,e]of [...this.#tasks])if(e.info.name===name&&this.cancel(id))count++;return count;}
 list():TaskInfo[]{return [...this.#tasks.values()].map(e=>({...e.info,history:[...(e.info.history??[])]}));}
 get(id:string):TaskInfo|undefined{const e=this.#tasks.get(id);return e?{...e.info,history:[...(e.info.history??[])]}:undefined;}
 get size():number{return this.#tasks.size;}
 async stopAll(graceMs=5000):Promise<void>{this.#stopped=true;const inflight:Promise<void>[]=[];for(const [id,e]of [...this.#tasks]){if(e.inflight)inflight.push(e.inflight);this.cancel(id);}if(inflight.length)await Promise.race([Promise.allSettled(inflight),new Promise<void>(resolve=>setTimeout(resolve,graceMs).unref?.())]);}
 async #run(entry:TaskEntry):Promise<void>{if(entry.controller.signal.aborted||entry.info.paused)return;if(entry.inflight)return entry.inflight;const execute=async()=>{const started=Date.now();entry.info.state='running';entry.info.startedAt=started;entry.info.runs++;this.#events?.emit('task:start',{taskId:entry.info.id,name:entry.info.name});try{await this.#withTimeout(Promise.resolve(entry.fn({signal:entry.controller.signal,taskId:entry.info.id,name:entry.info.name})),entry.options.timeoutMs,entry.info.name);const ms=Date.now()-started;entry.info.lastRunMs=ms;entry.info.state=entry.info.kind==='interval'?'pending':'done';if(entry.info.kind==='oneshot')entry.info.finishedAt=Date.now();this.#history(entry,{at:Date.now(),outcome:'succeeded',durationMs:ms});this.#events?.emit('task:done',{taskId:entry.info.id,name:entry.info.name,ms});}catch(error){const msg=error instanceof Error?error.message:String(error);const ms=Date.now()-started;entry.info.errors++;entry.info.lastError=msg;entry.info.lastRunMs=ms;entry.info.state=entry.info.kind==='interval'?'pending':'failed';this.#history(entry,{at:Date.now(),outcome:'failed',durationMs:ms,errorCode:errorCode(error)});this.#logger.error({task:entry.info.name,taskId:entry.info.id,err:msg},'task failed');this.#events?.emit('task:error',{taskId:entry.info.id,name:entry.info.name,error:msg});if(entry.info.kind==='interval'&&entry.options.continueOnError===false)this.cancel(entry.info.id);}};entry.inflight=execute().finally(()=>{entry.inflight=undefined;});return entry.inflight;}
 #history(entry:TaskEntry,row:TaskHistoryEntry){const history=entry.info.history??(entry.info.history=[]);history.unshift(row);history.splice(HISTORY_LIMIT);}
 async #withTimeout(promise:Promise<unknown>,timeoutMs:number|undefined,name:string):Promise<void>{if(!timeoutMs||timeoutMs<=0){await promise;return;}let timer:NodeJS.Timeout|undefined;try{await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(`task "${name}" timed out after ${timeoutMs}ms`)),timeoutMs);timer.unref?.();})]);}finally{if(timer)clearTimeout(timer);}}
}
