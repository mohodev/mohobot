import type { Logger } from '../core/logger.js';
import type { Storage } from '../storage/types.js';

export interface UserProfile { botId:string; userId:string; facts:string[]; updatedAt:number; }
export interface ChannelReflection { botId:string; channelId:string; exchanges:number; lastExchangeAt:number; }

const SENSITIVE = /(?:密码|token|密钥|secret|住址|身份证|银行卡|手机号|电话|email|邮箱)/i;
const PATTERNS = [/(?:我)?喜欢([^。！？，,]{1,40})/,/(?:我)?不喜欢([^。！？，,]{1,40})/,/(?:请)?叫我([^。！？，,]{1,24})/,/我叫([^。！？，,]{1,24})/,/我常用([^。！？，,]{1,40})/];

/** Local, deterministic post-turn reflection. It stores only explicit, non-sensitive facts. */
export class ProfileReflectionWorker {
  constructor(private readonly storage:Storage, private readonly logger:Logger, private readonly now=Date.now) {}
  async reflect(input:{botId:string;channelId:string;userId:string;userText:string}):Promise<{facts:number}> {
    const facts=this.#facts(input.userText); const profileKey=`profile:${input.botId}:${input.userId}`;
    if(facts.length){const previous=await this.storage.get<UserProfile>(profileKey);const merged=[...new Set([...(previous?.facts??[]),...facts])].slice(-20);await this.storage.save(profileKey,{botId:input.botId,userId:input.userId,facts:merged,updatedAt:this.now()});}
    const reflectionKey=`reflection:${input.botId}:${input.channelId}`;const prior=await this.storage.get<ChannelReflection>(reflectionKey);await this.storage.save(reflectionKey,{botId:input.botId,channelId:input.channelId,exchanges:(prior?.exchanges??0)+1,lastExchangeAt:this.now()});
    this.logger.debug({botId:input.botId,channelId:input.channelId,userId:input.userId,facts:facts.length},'post-turn reflection written');
    return{facts:facts.length};
  }
  #facts(text:string):string[]{if(SENSITIVE.test(text))return[];const out:string[]=[];for(const pattern of PATTERNS){const match=pattern.exec(text);const value=match?.[1]?.trim();if(value&&value.length>=1)out.push(value);}return[...new Set(out)].slice(0,3);}
}
