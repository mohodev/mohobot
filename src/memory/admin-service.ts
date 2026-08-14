import { createHash } from 'node:crypto';
import type { Storage } from '../storage/types.js';
import type { MemoryScope, SemanticMemoryRecord } from './semantic-memory.js';
const PREFIX = 'semantic-memory:';
export interface MemoryMetadata { id:string;key:string;botId:string;channelId:string;userId:string;scope:MemoryScope;createdAt:number;textLength:number;textHash:string;hasEmbedding:boolean;embeddingModel?:string; }
export interface MemoryDetail extends MemoryMetadata { text:string;user:SemanticMemoryRecord['user'];assistant:SemanticMemoryRecord['assistant']; }
function validRecord(value:unknown):value is SemanticMemoryRecord { if(!value||typeof value!=='object'||Array.isArray(value))return false;const x=value as Partial<SemanticMemoryRecord>;return typeof x.id==='string'&&typeof x.botId==='string'&&typeof x.channelId==='string'&&typeof x.userId==='string'&&['private','relationship','shared'].includes(String(x.scope))&&typeof x.text==='string'&&Number.isFinite(x.createdAt)&&Boolean(x.user&&x.assistant); }
function metadata(key:string,value:SemanticMemoryRecord):MemoryMetadata { return{id:value.id,key,botId:value.botId,channelId:value.channelId,userId:value.userId,scope:value.scope,createdAt:value.createdAt,textLength:Buffer.byteLength(value.text,'utf8'),textHash:createHash('sha256').update(value.text).digest('hex'),hasEmbedding:Boolean(value.vector?.length),...(value.embeddingModel?{embeddingModel:value.embeddingModel}:{})}; }
export class MemoryAdminService {
  constructor(readonly storage:Storage){}
  async list(filter:{botId?:string;channelId?:string;userId?:string;scope?:MemoryScope;limit?:number}={}):Promise<MemoryMetadata[]> {
    const limit=Math.min(200,Math.max(1,filter.limit??100));const prefix=filter.botId?`${PREFIX}${filter.botId}:`:PREFIX;
    const rows=await this.storage.query<unknown>({prefix,limit:limit*4});const output:MemoryMetadata[]=[];
    for(const row of rows){const value=row.value;if(!validRecord(value))continue;if(filter.channelId&&value.channelId!==filter.channelId)continue;if(filter.userId&&value.userId!==filter.userId)continue;if(filter.scope&&value.scope!==filter.scope)continue;output.push(metadata(row.key,value));if(output.length>=limit)break;}
    return output;
  }
  async get(key:string):Promise<MemoryDetail|undefined>{if(!key.startsWith(PREFIX))throw new Error('invalid memory key');const value=await this.storage.get<unknown>(key);if(!validRecord(value))return undefined;return{...metadata(key,value),text:value.text,user:value.user,assistant:value.assistant};}
  async delete(key:string):Promise<boolean>{if(!key.startsWith(PREFIX))throw new Error('invalid memory key');const existing=await this.storage.get<unknown>(key);if(!validRecord(existing))return false;await this.storage.delete(key);return true;}
}
