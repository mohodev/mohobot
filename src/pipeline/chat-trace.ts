export type ChatTraceStage = 'observed'|'merged'|'ignored'|'interrupted_previous'|'aborted'|'context'|'model_started'|'model_completed'|'model_failed'|'delta'|'plan_parsed'|'delivered'|'delivery_failed'|'memory_written'|'memory_failed';
export interface ChatTraceEvent { at:number; stage:ChatTraceStage; detail?:Record<string,string|number|boolean>; }
export interface ChatTrace { id:string; botId:string; messageId:string; channelId:string; userId:string; createdAt:number; events:ChatTraceEvent[]; outcome?:'ignored'|'replied'|'failed'; }

/** Bounded, metadata-only trace timeline. Deliberately never accepts message text or prompts. */
export class ChatTraceStore {
  #items:ChatTrace[]=[];
  constructor(private readonly capacity=500) {}
  start(input:Omit<ChatTrace,'id'|'createdAt'|'events'|'outcome'>):ChatTrace { const trace={...input,id:`ct_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`,createdAt:Date.now(),events:[]};this.#items.unshift(trace);this.#items.splice(this.capacity);return trace; }
  add(trace:ChatTrace,stage:ChatTraceStage,detail?:ChatTraceEvent['detail']):void { trace.events.push({at:Date.now(),stage,...(detail?{detail}:{})}); if(stage==='ignored')trace.outcome='ignored';if(stage==='delivered')trace.outcome='replied';if(stage==='model_failed'||stage==='delivery_failed')trace.outcome='failed'; }
  list(limit=100):ChatTrace[]{return this.#items.slice(0,Math.max(1,Math.min(500,limit))).map(item=>structuredClone(item));}
}
