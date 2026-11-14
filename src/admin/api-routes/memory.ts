import type { ApiResult } from '../api-types.js';
import type { AdminApiRouteContext, AdminApiRouteRequest } from '../api-router.js';
import { HttpError } from '../api-errors.js';
import type { ExpressionStatus } from '../../memory/expression-memory.js';
import { intParam, stringParam } from './helpers.js';

export async function handleMemoryRoutes(ctx: AdminApiRouteContext, route: AdminApiRouteRequest): Promise<ApiResult | undefined> {
  const { method, pathname, url, input, auth } = route;
  const stateBotId = route.stateBotId;
    if(method==='GET'&&pathname==='/api/memory/expressions'){
      const botId=url.searchParams.get('botId');if(!botId)throw new HttpError(400,'botId required');
      const userId=stringParam(url,'userId');const statusRaw=stringParam(url,'status');
      if(statusRaw&&!['pending','approved','rejected','superseded'].includes(statusRaw))throw new HttpError(400,'invalid status');
      const records=await ctx.deps.expressionGov.list(botId,userId??undefined,statusRaw as ExpressionStatus|undefined);
      return ctx.ok({records});
    }
    if(method==='POST'&&pathname==='/api/memory/semantic/bulk-delete'){
      const botId=String(input.botId??'');if(!botId)throw new HttpError(400,'botId required');
      const fields=['userId','channelId','sourceMessageId'] as const;
      for(const field of fields)if(input[field]!==undefined&&(typeof input[field]!=='string'||!input[field]))throw new HttpError(400,`${field} must be a non-empty string`);
      if(!fields.some((field)=>typeof input[field]==='string'))throw new HttpError(400,'at least one deletion filter required');
      const count=await ctx.deps.semanticGov.bulkDelete({botId,userId:input.userId as string|undefined,channelId:input.channelId as string|undefined,sourceMessageId:input.sourceMessageId as string|undefined},auth.principal.id,typeof input.reason==='string'?input.reason:undefined);
      return ctx.ok({deleted:count});
    }
    if(method==='GET'&&pathname==='/api/memory/semantic/recycle-bin'){
      const botId=url.searchParams.get('botId');if(!botId)throw new HttpError(400,'botId required');
      return ctx.ok({records:await ctx.deps.semanticGov.recycleBin(botId,intParam(url,'limit'))});
    }
    if(method==='POST'&&pathname==='/api/memory/semantic/restore'){
      const botId=String(input.botId??''),userId=String(input.userId??''),id=String(input.id??'');if(!botId||!userId||!id)throw new HttpError(400,'botId, userId, and id required');
      return ctx.ok({outcome:await ctx.deps.semanticGov.restore(botId,userId,id,auth.principal.id)});
    }
    if(method==='GET'&&pathname==='/api/memory/semantic/export'){
      const botId=url.searchParams.get('botId');if(!botId)throw new HttpError(400,'botId required');
      return ctx.ok({data:await ctx.deps.semanticGov.exportSanitized(botId)});
    }
    if(method==='POST'&&pathname==='/api/memory/semantic/import-dry-run'){
      if(typeof input.data!=='string')throw new HttpError(400,'data must be a JSONL string');
      return ctx.ok({result:ctx.deps.semanticGov.dryRunImport(input.data)});
    }
    if(method==='POST'&&pathname==='/api/memory/expressions/approve'){
      const botId=String(input.botId??'');const userId=String(input.userId??'');const id=String(input.id??'');
      if(!botId||!userId||!id)throw new HttpError(400,'botId, userId, and id required');
      const outcome=await ctx.deps.expressionGov.approve(botId,userId,id,auth.principal.id);
      return ctx.ok({outcome});
    }
    if(method==='POST'&&pathname==='/api/memory/expressions/reject'){
      const botId=String(input.botId??'');const userId=String(input.userId??'');const id=String(input.id??'');
      if(!botId||!userId||!id)throw new HttpError(400,'botId, userId, and id required');
      const outcome=await ctx.deps.expressionGov.reject(botId,userId,id,auth.principal.id);
      return ctx.ok({outcome});
    }
    if(method==='POST'&&pathname==='/api/memory/expressions/bulk-delete'){
      const botId=String(input.botId??'');if(!botId)throw new HttpError(400,'botId required');
      const userId=typeof input.userId==='string'?input.userId:undefined;
      const channelId=typeof input.channelId==='string'?input.channelId:undefined;
      const before=typeof input.before==='number'&&Number.isFinite(input.before)?input.before:undefined;
      const reason=typeof input.reason==='string'?input.reason:undefined;
      const count=await ctx.deps.expressionGov.bulkDelete({botId,userId,channelId,before},auth.principal.id,reason);
      return ctx.ok({deleted:count});
    }
    if(method==='GET'&&pathname==='/api/memory/expressions/recycle-bin'){
      const botId=url.searchParams.get('botId');if(!botId)throw new HttpError(400,'botId required');
      const limit=intParam(url,'limit');if(limit!==undefined&&(limit<1||limit>1000))throw new HttpError(400,'invalid limit');
      const records=await ctx.deps.expressionGov.recycleBin(botId,limit);
      return ctx.ok({records});
    }
    if(method==='POST'&&pathname==='/api/memory/expressions/restore'){
      const botId=String(input.botId??'');const userId=String(input.userId??'');const id=String(input.id??'');
      if(!botId||!userId||!id)throw new HttpError(400,'botId, userId, and id required');
      const outcome=await ctx.deps.expressionGov.restore(botId,userId,id,auth.principal.id);
      if(outcome==='invalid')throw new HttpError(409,'record has expired and cannot be restored');
      return ctx.ok({outcome});
    }
    if(method==='GET'&&pathname==='/api/memory/expressions/export'){
      const botId=url.searchParams.get('botId');if(!botId)throw new HttpError(400,'botId required');
      const statusRaw=stringParam(url,'status');
      if(statusRaw&&!['pending','approved','rejected','superseded'].includes(statusRaw))throw new HttpError(400,'invalid status');
      const limit=intParam(url,'limit');if(limit!==undefined&&(limit<1||limit>5000))throw new HttpError(400,'invalid limit');
      const jsonl=await ctx.deps.expressionGov.exportSanitized(botId,{status:statusRaw as ExpressionStatus|undefined,limit});
      return ctx.ok({data:jsonl});
    }
    if(method==='GET'&&pathname==='/api/memory/jargon'){
      const status=stringParam(url,'status');
      if(status&&!['candidate','approved','rejected'].includes(status))throw new HttpError(400,'invalid status');
      return ctx.ok({entries:await ctx.deps.jargon.list({channelId:stringParam(url,'channelId'),guildId:stringParam(url,'guildId'),status:status as 'candidate'|'approved'|'rejected'|undefined,limit:intParam(url,'limit'),offset:intParam(url,'offset')})});
    }
    if(method==='POST'&&pathname==='/api/memory/jargon/approve'){
      const id=typeof input.id==='string'?input.id:'';if(!id)throw new HttpError(400,'id required');
      return ctx.ok({outcome:await ctx.deps.jargon.approve(id,auth.principal.id)});
    }
    if(method==='POST'&&pathname==='/api/memory/jargon/reject'){
      const id=typeof input.id==='string'?input.id:'';if(!id)throw new HttpError(400,'id required');
      return ctx.ok({outcome:await ctx.deps.jargon.reject(id,auth.principal.id)});
    }
    if(method==='GET'&&pathname==='/api/memory'){const scope=url.searchParams.get('scope');if(scope&&!['private','relationship','shared'].includes(scope))throw new HttpError(400,'invalid scope');const rawLimit=url.searchParams.get('limit');const limit=rawLimit===null?undefined:Number(rawLimit);if(limit!==undefined&&(!Number.isSafeInteger(limit)||limit<1||limit>200))throw new HttpError(400,'invalid limit');return ctx.ok({memories:await ctx.deps.memories.list({botId:url.searchParams.get('botId')||undefined,channelId:url.searchParams.get('channelId')||undefined,userId:url.searchParams.get('userId')||undefined,scope:scope as any,limit})});}
    const memoryMatch=pathname.match(/^\/api\/memory\/([^/]+)$/);if(method==='GET'&&memoryMatch){const memory=await ctx.deps.memories.get(decodeURIComponent(memoryMatch[1]!));if(!memory)throw new HttpError(404,'memory not found');return ctx.ok({memory});}if(method==='DELETE'&&memoryMatch){const deleted=await ctx.deps.memories.delete(decodeURIComponent(memoryMatch[1]!));if(!deleted)throw new HttpError(404,'memory not found');return ctx.ok({deleted:true});}

  return undefined;
}
