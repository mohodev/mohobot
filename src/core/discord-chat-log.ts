/**
 * Admin-only Discord chat log - in-memory ring buffer, never persisted.
 *
 * Records the most recent Discord inbound/outbound chat exchanges (with a
 * bounded content summary) so the admin console can inspect live traffic.
 * Deliberately memory-only: process restart wipes it and no chat body ever
 * reaches SQLite or disk. Console/webhook/debug-chat traffic is never
 * recorded; the recorder itself enforces platform === 'discord'.
 */

import { scrub } from './logger.js';
import type { Platform } from './types.js';

export type DiscordChatDirection = 'in' | 'out';
export type DiscordChatOutcome = 'received' | 'delivered' | 'delivery_failed';

export interface DiscordChatLogEntry {
  seq: number;
  /** Epoch millis. */
  time: number;
  direction: DiscordChatDirection;
  botId: string;
  channelId: string;
  /** Inbound author id, or the bot's own id for outbound entries. */
  userId: string;
  /** Scrubbed content preview; hard-capped at maxSummaryLength (default 500). */
  summary: string;
  traceId?: string;
  outcome: DiscordChatOutcome;
}

export interface DiscordChatLogInput {
  platform: Platform;
  direction: DiscordChatDirection;
  botId: string;
  channelId: string;
  userId: string;
  content: string;
  outcome?: DiscordChatOutcome;
  traceId?: string;
  time?: number;
}

export interface DiscordChatLogQuery {
  limit?: number;
  direction?: DiscordChatDirection;
  channelId?: string;
  botId?: string;
}

export interface DiscordChatLogOptions { capacity?: number; maxSummaryLength?: number }

const DEFAULT_CAPACITY = 500;
const DEFAULT_MAX_SUMMARY = 500;
export const DISCORD_CHAT_LOG_QUERY_LIMIT = 200;

function positive(value:number|undefined,fallback:number):number{return Number.isSafeInteger(value)&&value!>0?value!:fallback;}

/** Bounded FIFO of recent Discord chat exchanges, newest returned first. */
export class DiscordChatLogBuffer {
  readonly #capacity:number;readonly #maxSummary:number;
  readonly #entries:DiscordChatLogEntry[]=[];#seq=0;
  constructor(options:DiscordChatLogOptions={}){this.#capacity=positive(options.capacity,DEFAULT_CAPACITY);this.#maxSummary=positive(options.maxSummaryLength,DEFAULT_MAX_SUMMARY);}
  /** Record one exchange. Non-Discord platforms are silently ignored. Never throws. */
  record(input:DiscordChatLogInput):DiscordChatLogEntry|undefined{
    try{
      if(input.platform!=='discord')return undefined;
      const channel=input.channelId.trim();if(!channel)return undefined;
      const outcome=input.outcome??(input.direction==='in'?'received':'delivered');
      const entry:DiscordChatLogEntry={seq:++this.#seq,time:Number.isFinite(input.time)?input.time!:Date.now(),direction:input.direction,botId:input.botId,channelId:channel,userId:input.userId,summary:this.#summarize(input.content),...(input.traceId?{traceId:input.traceId}:{}),outcome};
      this.#entries.push(entry);if(this.#entries.length>this.#capacity)this.#entries.splice(0,this.#entries.length-this.#capacity);
      return structuredClone(entry);
    }catch{return undefined;}
  }
  /** Most recent entries newest-first, capped at DISCORD_CHAT_LOG_QUERY_LIMIT. */
  query(query:DiscordChatLogQuery={}):DiscordChatLogEntry[]{
    const limit=Math.min(positive(query.limit,100),DISCORD_CHAT_LOG_QUERY_LIMIT);
    const direction=query.direction,channelId=query.channelId?.trim(),botId=query.botId?.trim();
    const out:DiscordChatLogEntry[]=[];
    for(let i=this.#entries.length-1;i>=0&&out.length<limit;i-=1){const entry=this.#entries[i]!;if(direction&&entry.direction!==direction)continue;if(channelId&&entry.channelId!==channelId)continue;if(botId&&entry.botId!==botId)continue;out.push(structuredClone(entry));}
    return out;
  }
  clear():void{this.#entries.length=0;}
  #summarize(content:string):string{const safe=scrub(String(content??'')).replace(/\s+/g,' ').trim();return safe.length<=this.#maxSummary?safe:`${safe.slice(0,Math.max(0,this.#maxSummary-1))}…`;}
}

/** Process-wide singleton shared by the pipeline (writer) and admin server (reader). */
export const discordChatLog = new DiscordChatLogBuffer();
