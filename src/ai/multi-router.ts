import type { AIConfig } from '../config/schema.js';
import type { ChatMessage } from '../core/types.js';
import type { Logger } from '../core/logger.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { BudgetedProvider, ModelBudgetError, type ModelBudget, type ModelTask } from './router.js';
import { AIError, type AIProvider, type AIResponse, type ChatOptions } from './types.js';
import { CircuitBreaker, CircuitOpenError, type CircuitSnapshot } from './circuit-breaker.js';

export interface ProviderProfile {baseUrl:string;apiKey?:string;model:string;maxTokens?:number;temperature?:number;timeoutMs?:number;budget?:Partial<ModelBudget>;circuit?:{failureThreshold?:number;openMs?:number};}
export interface TaskRoute { primary:string; fallback?:string; }
interface ProfileRuntime{provider:AIProvider;breaker:CircuitBreaker;model:string;lastProbe?:{ok:boolean;checkedAt:number;detail?:string};}
function fallbackEligible(error:unknown):boolean{if(error instanceof AIError)return ['network','timeout','server','rate_limit','auth'].includes(error.kind);return error instanceof ModelBudgetError||error instanceof CircuitOpenError;}
function failureKind(error:unknown):string|undefined{if(error instanceof AIError&&fallbackEligible(error))return error.kind;if(error instanceof CircuitOpenError)return'circuit_open';return undefined;}

/** Health-aware task router with bounded fallback and per-profile circuit breakers. */
export class MultiProviderRouter implements AIProvider {
 readonly #profiles:Map<string,ProfileRuntime>;readonly #routes:Partial<Record<ModelTask,TaskRoute>>;readonly #default:string;
 constructor(input:{profiles:Record<string,ProviderProfile>;routes:Partial<Record<ModelTask,TaskRoute>>;defaultProfile:string;logger:Logger}){this.#profiles=new Map(Object.entries(input.profiles).map(([id,p])=>{const cfg={provider:'openai-compatible',baseUrl:p.baseUrl,apiKey:p.apiKey??'',model:p.model,temperature:p.temperature??.7,maxTokens:p.maxTokens??0,timeoutMs:p.timeoutMs??60_000,retries:2,retryBaseDelayMs:500,stream:false,fallbackReply:'',options:{}}satisfies AIConfig;const provider=new BudgetedProvider(new OpenAICompatibleProvider(cfg,{logger:input.logger.child({providerProfile:id})}),p.budget);return[id,{provider,breaker:new CircuitBreaker(p.circuit),model:p.model}]}));this.#routes=input.routes;this.#default=input.defaultProfile;}
 get name():string{return'multi-provider-router';}get model():string{return this.#profiles.get(this.#default)?.model??'unconfigured';}
 async health():Promise<{ok:boolean;detail?:string}>{const results=await this.probeAll();const ok=results.some(x=>x.ok);return{ok,detail:results.map(x=>`${x.id}:${x.ok?'ok':'down'}`).join(', ')||'no profiles'};}
 profileIds():string[]{return[...this.#profiles.keys()];}
 async probeProfile(id:string):Promise<{id:string;model:string;ok:boolean;detail?:string;circuit:CircuitSnapshot;checkedAt:number}>{const r=this.#profiles.get(id);if(!r)throw new Error(`provider profile not found: ${id}`);let result:{ok:boolean;detail?:string};try{result=await r.provider.health();}catch(error){result={ok:false,detail:error instanceof Error?error.message:'probe failed'};}r.lastProbe={...result,checkedAt:Date.now()};return{id,model:r.model,...result,circuit:r.breaker.snapshot(),checkedAt:r.lastProbe.checkedAt};}
 async probeAll():Promise<Array<{id:string;model:string;ok:boolean;detail?:string;circuit:CircuitSnapshot;checkedAt:number}>>{return Promise.all(this.profileIds().map(id=>this.probeProfile(id)));}
 snapshots():Record<string,{model:string;circuit:CircuitSnapshot;lastProbe?:{ok:boolean;checkedAt:number;detail?:string}}>{return Object.fromEntries([...this.#profiles].map(([id,r])=>[id,{model:r.model,circuit:r.breaker.snapshot(),lastProbe:r.lastProbe}]));}
 async chat(messages:ChatMessage[],options:ChatOptions={}):Promise<AIResponse>{const route=this.#routes[options.task??'reply']??{primary:this.#default};try{return await this.#call(route.primary,messages,options);}catch(error){if(!route.fallback||!fallbackEligible(error))throw error;return this.#call(route.fallback,messages,options);}}
 async #call(id:string,messages:ChatMessage[],options:ChatOptions):Promise<AIResponse>{const runtime=this.#profiles.get(id);if(!runtime)throw new Error(`provider profile not found: ${id}`);if(!runtime.breaker.acquire())throw new CircuitOpenError();try{const response=await runtime.provider.chat(messages,options);runtime.breaker.success();return response;}catch(error){const kind=failureKind(error);if(kind)runtime.breaker.failure(kind);else runtime.breaker.release();throw error;}}
}
export function isProviderProfiles(value:unknown):value is Record<string,ProviderProfile>{if(!value||typeof value!=='object'||Array.isArray(value))return false;return Object.values(value).every(p=>{const c=p as Partial<ProviderProfile>;return typeof c.baseUrl==='string'&&typeof c.model==='string';});}
