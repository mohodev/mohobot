import { scrub, type LogLevel } from './logger.js';

export interface BufferedLogEntry {
  seq: number;
  time: number;
  level: LogLevel;
  component: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface LogBufferQuery {
  after?: number;
  limit?: number;
  level?: LogLevel;
  component?: string;
}

export interface LogBufferPage {
  items: BufferedLogEntry[];
  oldestSeq: number;
  latestSeq: number;
  nextSeq: number;
  gap: boolean;
}

export interface LogSinkRecord {
  level: LogLevel;
  time?: number;
  bindings?: Record<string, unknown>;
  message?: string;
  data?: unknown;
}

export interface LogSink { write(record: LogSinkRecord): void }
export interface LogBufferOptions { capacity?: number; maxFields?: number; maxStringLength?: number; maxMessageLength?: number }

const SENSITIVE_NAMES = ['token','secret','password','authorization','cookie','apikey','content','prompt','body','text','message','messages','transcript','stack'] as const;
function sensitiveKey(key:string):boolean{const normalized=key.replace(/[^a-z0-9]/gi,'').toLowerCase();return SENSITIVE_NAMES.some(name=>normalized===name||normalized.endsWith(name));}
const LEVELS = new Set<LogLevel>(['trace','debug','info','warn','error','fatal']);
function positive(value:number|undefined,fallback:number,max:number):number{return Number.isSafeInteger(value)&&value!>0?Math.min(value!,max):fallback;}
function clipped(value:string,max:number):string{const safe=scrub(value);return safe.length<=max?safe:`${safe.slice(0,Math.max(0,max-1))}…`;}

/** In-memory, bounded, already-redacted operational log view. Never stores chat/prompt bodies. */
export class LogBuffer implements LogSink {
  readonly #capacity:number;readonly #maxFields:number;readonly #maxString:number;readonly #maxMessage:number;
  readonly #entries:BufferedLogEntry[]=[];#seq=0;
  constructor(options:LogBufferOptions={}){this.#capacity=positive(options.capacity,500,10_000);this.#maxFields=positive(options.maxFields,12,50);this.#maxString=positive(options.maxStringLength,256,2_000);this.#maxMessage=positive(options.maxMessageLength,512,4_000);}
  write(record:LogSinkRecord):void{
    if(!LEVELS.has(record.level))return;
    const bindings=this.#safeObject(record.bindings);const data=this.#safeObject(record.data);
    const component=this.#component(bindings);
    for(const key of ['component','mod','module','bot','plugin'])delete bindings[key];
    const merged={...bindings,...data};
    const entry:BufferedLogEntry={seq:++this.#seq,time:Number.isFinite(record.time)?record.time!:Date.now(),level:record.level,component,message:clipped(record.message??'',this.#maxMessage),...(Object.keys(merged).length?{data:merged}:{})};
    this.#entries.push(entry);if(this.#entries.length>this.#capacity)this.#entries.splice(0,this.#entries.length-this.#capacity);
  }
  query(query:LogBufferQuery={}):LogBufferPage{
    const after=Number.isSafeInteger(query.after)&&query.after!>=0?query.after!:0;const limit=positive(query.limit,100,500);
    const oldestSeq=this.#entries[0]?.seq??this.#seq+1,latestSeq=this.#seq;const gap=after>0&&after<oldestSeq-1;
    const component=query.component?.trim().toLowerCase();
    const items=this.#entries.filter(entry=>entry.seq>after&&(!query.level||entry.level===query.level)&&(!component||entry.component.toLowerCase()===component)).slice(0,limit).map(entry=>structuredClone(entry));
    const nextSeq=items.at(-1)?.seq??latestSeq;
    return{items,oldestSeq,latestSeq,nextSeq,gap};
  }
  #component(bindings:Record<string,unknown>):string{for(const key of ['component','mod','module','plugin','bot']){const value=bindings[key];if(typeof value==='string'&&value.trim())return clipped(value.trim(),64);}return'core';}
  #safeObject(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))return{};const out:Record<string,unknown>={};let fields=0;for(const[key,item]of Object.entries(value as Record<string,unknown>)){if(fields>=this.#maxFields)break;if(sensitiveKey(key))continue;const safe=this.#safeValue(item,0);if(safe===undefined)continue;out[clipped(key,64)]=safe;fields++;}return out;}
  #safeValue(value:unknown,depth:number):unknown{if(value===null||typeof value==='boolean')return value;if(typeof value==='number')return Number.isFinite(value)?value:undefined;if(typeof value==='string')return clipped(value,this.#maxString);if(value instanceof Error)return{name:clipped(value.name,64),error:clipped(value.message,this.#maxString)};if(depth>=2)return undefined;if(Array.isArray(value))return value.slice(0,5).map(item=>this.#safeValue(item,depth+1)).filter(item=>item!==undefined);if(value&&typeof value==='object'){const out:Record<string,unknown>={};let count=0;for(const[key,item]of Object.entries(value as Record<string,unknown>)){if(count>=Math.min(6,this.#maxFields)||sensitiveKey(key))continue;const safe=this.#safeValue(item,depth+1);if(safe!==undefined){out[clipped(key,64)]=safe;count++;}}return Object.keys(out).length?out:undefined;}return undefined;}
}
