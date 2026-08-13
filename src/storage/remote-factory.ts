import type { Logger } from '../core/logger.js';
import type { RemoteMirror } from './outbox-worker.js';
import type { RemoteStorageConfig } from './remote-config.js';

export interface OptionalRemoteDrivers {
  mysql?: { mirror: RemoteMirror; health: () => Promise<{ ok:boolean; detail?:string }> };
  kafka?: { mirror: RemoteMirror; health: () => Promise<{ ok:boolean; detail?:string }>; close?:()=>Promise<void> };
  redis?: { health: () => Promise<{ ok:boolean; detail?:string }> };
}
export interface RemoteServices { mirrors: RemoteMirror[]; health():Promise<Record<string,{enabled:boolean;ok:boolean;detail?:string}>>; close():Promise<void>; }

/** Compose optional injected drivers; this module never imports vendor SDKs. */
export function createRemoteServices(config:RemoteStorageConfig,drivers:OptionalRemoteDrivers,logger:Logger):RemoteServices{
  const mirrors:RemoteMirror[]=[];
  if(config.mysql.enabled&&drivers.mysql)mirrors.push(drivers.mysql.mirror);
  if(config.kafka.enabled&&drivers.kafka)mirrors.push(drivers.kafka.mirror);
  return{mirrors,async health(){const result:Record<string,{enabled:boolean;ok:boolean;detail?:string}>={};for(const [name,enabled,driver] of [['mysql',config.mysql.enabled,drivers.mysql],['redis',config.redis.enabled,drivers.redis],['kafka',config.kafka.enabled,drivers.kafka]] as const){if(!enabled){result[name]={enabled:false,ok:true};continue;}if(!driver){result[name]={enabled:true,ok:false,detail:'driver not installed'};continue;}try{result[name]={enabled:true,...await driver.health()};}catch(error){logger.warn({service:name,err:error},'remote health failed');result[name]={enabled:true,ok:false,detail:'health check failed'};}}return result;},async close(){await drivers.kafka?.close?.().catch(error=>logger.warn({err:error},'kafka close failed'));}};
}
