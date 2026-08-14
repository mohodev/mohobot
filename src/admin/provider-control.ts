import type { ResolvedBotConfig } from '../config/schema.js';
import type { Logger } from '../core/logger.js';
import { OpenAICompatibleProvider } from '../ai/openai-compatible.js';

export interface ProviderControl {
  list(): Array<{botId:string;provider:string;model:string;baseUrlConfigured:boolean;apiKeyConfigured:boolean;taskRoutes:unknown}>;
  probe(botId:string):Promise<{botId:string;ok:boolean;detail?:string;checkedAt:number}>;
}
/** Read-only configuration projection plus one bounded health probe; secrets never leave this boundary. */
export class ProviderControlFacade implements ProviderControl {
  readonly #bots:()=>ResolvedBotConfig[];readonly #logger:Logger;
  constructor(input:{bots:()=>ResolvedBotConfig[];logger:Logger}){this.#bots=input.bots;this.#logger=input.logger.child({component:'provider-control'});}
  list(){return this.#bots().map(bot=>({botId:bot.id,provider:bot.ai.provider,model:bot.ai.model,baseUrlConfigured:Boolean(bot.ai.baseUrl),apiKeyConfigured:Boolean(bot.ai.apiKey),taskRoutes:(bot.ai.options as Record<string,unknown>).taskRoutes??{}}));}
  async probe(botId:string){const bot=this.#bots().find(x=>x.id===botId);if(!bot)throw new ProviderControlError('not_found');const checkedAt=Date.now();if(!bot.ai.apiKey)return{botId,ok:false,detail:'API key not configured',checkedAt};try{const p=new OpenAICompatibleProvider(bot.ai,{logger:this.#logger});const health=await p.health();return{botId,ok:health.ok,...(health.detail?{detail:health.detail}:{}),checkedAt};}catch{return{botId,ok:false,detail:'health probe failed',checkedAt};}}
}
export class ProviderControlError extends Error{constructor(readonly code:'not_found'){super(code);}}
