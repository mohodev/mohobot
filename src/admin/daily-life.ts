import type { AIProvider } from '../ai/types.js';
import type { WorldState } from './world.js';

export interface DailyLifeEvent { activity: string; location: string; durationMinutes: number; energyDelta: number; stressDelta: number; reason: string; source: 'model'|'rules'; }
const RULES: Omit<DailyLifeEvent,'source'>[] = [
  { activity:'随便逛逛',location:'附近',durationMinutes:50,energyDelta:-.05,stressDelta:-.06,reason:'换换心情' },
  { activity:'玩一会儿游戏',location:'住处',durationMinutes:80,energyDelta:-.04,stressDelta:-.08,reason:'消遣' },
  { activity:'整理房间',location:'住处',durationMinutes:35,energyDelta:-.04,stressDelta:-.03,reason:'保持生活秩序' },
  { activity:'找点东西吃',location:'附近',durationMinutes:45,energyDelta:.06,stressDelta:-.02,reason:'补充能量' },
];
function clamp(n:number,min:number,max:number):number{return Math.max(min,Math.min(max,n));}

export class DailyLifeSimulator {
  readonly #provider?: AIProvider;
  constructor(provider?:AIProvider){this.#provider=provider;}
  async propose(world:WorldState,character:string):Promise<DailyLifeEvent>{
    if(this.#provider){try{const r=await this.#provider.chat([{role:'system',content:'为虚构角色生成一个普通、低戏剧性的日常活动。只输出JSON：{"activity":"","location":"","durationMinutes":60,"energyDelta":-0.05,"stressDelta":-0.02,"reason":""}。不要搜索，不要生成演唱会、新闻、灾难或公开活动。'},{role:'user',content:JSON.stringify({character,world:{location:world.location,activity:world.activity,mood:world.mood}})}],{task:`world`,temperature:.8,timeoutMs:8000});const x=JSON.parse(r.content) as Partial<DailyLifeEvent>;if(!x.activity||!x.location)throw new Error('invalid');return{activity:x.activity,location:x.location,durationMinutes:clamp(Number(x.durationMinutes)||60,10,240),energyDelta:clamp(Number(x.energyDelta)||0,-.2,.2),stressDelta:clamp(Number(x.stressDelta)||0,-.2,.2),reason:x.reason||'日常选择',source:'model'};}catch{/* rule fallback */}}
    const index=Math.abs(new Date(world.clock).getUTCHours()+Math.round((world.mood.curiosity??.5)*10))%RULES.length;return{...RULES[index]!,source:'rules'};
  }
}
