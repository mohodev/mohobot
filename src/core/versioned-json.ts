import fs from 'node:fs/promises';
import { atomicWriteJson } from './atomic-json.js';

export interface VersionedJsonEnvelope<T> { format: 'mohobot-json'; version: number; revision: number; data: T; }
export class FutureJsonVersionError extends Error { constructor(readonly file: string, readonly found: number, readonly supported: number) { super(`unsupported future JSON version ${found}; maximum supported version is ${supported}`); this.name = 'FutureJsonVersionError'; } }
export class JsonRevisionConflictError extends Error { constructor(readonly expected: number, readonly actual: number) { super(`JSON revision conflict: expected ${expected}, found ${actual}`); this.name = 'JsonRevisionConflictError'; } }
export interface VersionedJsonStoreOptions<T> { file: string; version?: number; defaultValue: () => T; normalize?: (value: unknown) => T; }
const queues = new Map<string, Promise<unknown>>();
function isEnvelope(value: unknown): value is VersionedJsonEnvelope<unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) return false; const row = value as Partial<VersionedJsonEnvelope<unknown>>; return row.format === 'mohobot-json' && Number.isSafeInteger(row.version) && (row.version ?? 0) > 0 && Number.isSafeInteger(row.revision) && (row.revision ?? 0) > 0 && 'data' in row; }

/** Versioned durable JSON state. Non-ENOENT read errors are never overwritten. */
export class VersionedJsonStore<T> {
  readonly #file: string; readonly #version: number; readonly #defaultValue: () => T; readonly #normalize: (value: unknown) => T;
  constructor(options: VersionedJsonStoreOptions<T>) { this.#file=options.file; this.#version=options.version??1; this.#defaultValue=options.defaultValue; this.#normalize=options.normalize??((value)=>value as T); if(!Number.isSafeInteger(this.#version)||this.#version<1)throw new Error('JSON version must be a positive safe integer'); }
  async get(): Promise<T> { return (await this.read()).data; }
  async read(): Promise<VersionedJsonEnvelope<T>> { return this.#serial(()=>this.#readOrCreate()); }
  async save(data:T,expectedRevision?:number):Promise<VersionedJsonEnvelope<T>> { return this.#serial(async()=>{const current=await this.#readOrCreate();if(expectedRevision!==undefined&&current.revision!==expectedRevision)throw new JsonRevisionConflictError(expectedRevision,current.revision);return this.#write(this.#normalize(data),current.revision+1);}); }
  async update(mutator:(current:T)=>T|Promise<T>):Promise<VersionedJsonEnvelope<T>> { return this.#serial(async()=>{const current=await this.#readOrCreate();const next=this.#normalize(await mutator(structuredClone(current.data)));return this.#write(next,current.revision+1);}); }
  async #readOrCreate():Promise<VersionedJsonEnvelope<T>> { let raw:string;try{raw=await fs.readFile(this.#file,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;return this.#write(this.#normalize(this.#defaultValue()),1);}const parsed=JSON.parse(raw)as unknown;if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)&&(parsed as{format?:unknown}).format==='mohobot-json'&&!isEnvelope(parsed))throw new Error('invalid versioned JSON envelope');if(isEnvelope(parsed)){if(parsed.version>this.#version)throw new FutureJsonVersionError(this.#file,parsed.version,this.#version);const normalized=this.#normalize(parsed.data);if(parsed.version===this.#version)return{...parsed,data:normalized};return this.#write(normalized,parsed.revision+1);}return this.#write(this.#normalize(parsed),1); }
  async #write(data:T,revision:number):Promise<VersionedJsonEnvelope<T>> { const envelope:VersionedJsonEnvelope<T>={format:'mohobot-json',version:this.#version,revision,data};await atomicWriteJson(this.#file,envelope);return envelope; }
  #serial<R>(operation:()=>Promise<R>):Promise<R>{const previous=queues.get(this.#file)??Promise.resolve();const current=previous.then(operation,operation);queues.set(this.#file,current.then(()=>undefined,()=>undefined));return current;}
}
