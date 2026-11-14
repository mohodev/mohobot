import type { ApiResult } from '../api-types.js';
import type { AdminApiRouteContext, AdminApiRouteRequest } from '../api-router.js';
import { HttpError } from '../api-errors.js';
import { listPersistentDomains, queryPersistentTraces } from '../world-isolation.js';
import { RuleDayPlanner } from '../day-planner.js';
import { behaviorDryRun, parseBehaviorDryRun } from '../behavior-dry-run.js';
import { parseAffinityAdjust, parseDevicePatch } from '../input-validation.js';
import { DiscordDeliveryOutbox } from '../../discord/outbox.js';
import type { OpsControlFacade } from '../ops-control.js';
import { intParam, stringParam, requireOps } from './helpers.js';

export async function handleWorldTaskGuildRoutes(ctx: AdminApiRouteContext, route: AdminApiRouteRequest): Promise<ApiResult | undefined> {
  const { method, pathname, url, input, auth } = route;
  const stateBotId = route.stateBotId;
    if (method === 'GET' && pathname === '/api/world') return ctx.ok({ world: await ctx.worldFor(stateBotId()).get() });
     if(method==='GET'&&pathname==='/api/world/schedule'){const world=await ctx.worldFor(ctx.stateBotId(stringParam(url,'botId'))).get();return ctx.ok({schedule:world.schedule,domains:await listPersistentDomains()});}
     if(method==='GET'&&pathname==='/api/world/trace')return ctx.ok({traces:await queryPersistentTraces({botId:stringParam(url,'botId'),domainId:stringParam(url,'domainId'),limit:intParam(url,'limit')})});
    if(method==='GET'&&pathname==='/api/tasks/future'){
      const status=stringParam(url,'status');if(status&&!['pending','claimed','completed','failed','expired','uncertain'].includes(status))throw new HttpError(400,'invalid task status');
      const limit=intParam(url,'limit');if(limit!==undefined&&(limit<1||limit>500))throw new HttpError(400,'invalid limit');
      const globalRead=auth.principal.role==='admin'||auth.principal.role==='developer';
      return ctx.ok({tasks:await ctx.deps.futureTasks.list({status:status as any,owner:globalRead?stringParam(url,'owner'):auth.principal.id,type:stringParam(url,'type'),limit})});
    }
    if(method==='POST'&&pathname==='/api/tasks/future/schedule'){
      const type=typeof input.type==='string'?input.type:'';const owner=auth.principal.id;
      if(!type||!input.payload||typeof input.payload!=='object'||Array.isArray(input.payload))throw new HttpError(400,'type and object payload required');
       const payload=input.payload as Record<string,unknown>;
       if(type==='world.tick') {
         if(typeof payload.botId!=='string')throw new HttpError(400,'invalid botId');
       } else if(type==='discord.deliver') {
         if(Object.keys(payload).some((key)=>!['botId','channelId','dedupeKey','content'].includes(key))||typeof payload.botId!=='string'||typeof payload.channelId!=='string'||!/^\d{1,32}$/.test(payload.channelId)||typeof payload.dedupeKey!=='string'||!/^[\w:.\-]{1,160}$/.test(payload.dedupeKey)||typeof payload.content!=='string'||payload.content.length===0||payload.content.length>2000)throw new HttpError(400,'invalid discord.deliver payload');
       } else throw new HttpError(400,'unsupported task type');
       if(!ctx.deps.opts.snapshots().some((snapshot)=>snapshot.id===payload.botId))throw new HttpError(404,'bot not found');
       const task=await ctx.deps.futureTasks.schedule({type,payload,owner,scheduledAt:typeof input.scheduledAt==='number'?input.scheduledAt:undefined,maxRetries:typeof input.maxRetries==='number'?input.maxRetries:undefined,timeoutMs:typeof input.timeoutMs==='number'?input.timeoutMs:undefined});
       return{status:201,body:{ok:true,task}};
     }
     const reconcileMatch=pathname.match(/^\/api\/tasks\/future\/([^/]+)\/reconcile$/);
     if(method==='POST'&&reconcileMatch){
       const task=await ctx.deps.futureTasks.get(decodeURIComponent(reconcileMatch[1]!));
       if(!task)throw new HttpError(404,'task not found');
       if(task.owner!==auth.principal.id&&!['admin','developer'].includes(auth.principal.role))throw new HttpError(404,'task not found');
       if(task.status!=='uncertain')throw new HttpError(409,'task is not uncertain');
       if(task.type!=='discord.deliver')throw new HttpError(409,'task type is not reconcilable');
       const key=task.payload.dedupeKey;
       if(typeof key!=='string')throw new HttpError(400,'invalid dedupeKey');
       const record=await new DiscordDeliveryOutbox(ctx.deps.opts.storage).get(key);
       const outcome=record?.status==='delivered'?'delivered':record?.status==='rejected'?'rejected':'unknown';
       const updated=await ctx.deps.futureTasks.reconcile(task.id,outcome,record?.error??'outbox record does not establish delivery');
       return ctx.ok({task:updated,record});
     }
    if (method === 'POST' && pathname === '/api/world/schedule') return { status: 201, body: { ok: true, world: await ctx.worldFor(stateBotId()).schedule({ ...input, trust: 'candidate' }) } };
    if (method === 'POST' && pathname === '/api/world/schedule/dry-run') return ctx.ok({ world: await ctx.worldFor(stateBotId()).dryRun(input, typeof input.at === 'number' ? input.at : Date.now()) });
    if (method === 'POST' && /^\/api\/world\/schedule\/[^/]+\/trust$/.test(pathname)) {
      const id = decodeURIComponent(pathname.split('/')[4] ?? '');
      const trust = String(input.trust ?? 'candidate');
      if (!['candidate', 'confirmed', 'rejected'].includes(trust)) throw new HttpError(400, 'invalid trust');
      return ctx.ok({ world: await ctx.worldFor(stateBotId()).confirmScheduled(id, trust as 'candidate'|'confirmed'|'rejected') });
    }
    if (method === 'POST' && pathname === '/api/world/tick') return ctx.ok({ world: await ctx.worldFor(stateBotId()).tick() });
    if (method === 'GET' && pathname === '/api/world/day-plan') {
      const world = await ctx.worldFor(stateBotId()).get();
      const plan = await new RuleDayPlanner().plan({ date: new Date().toISOString().slice(0, 10), character: 'MohoBot', world });
      return ctx.ok({ plan });
    }
    if (method === 'POST' && pathname === '/api/world/events') return { status: 201, body: { ok: true, world: await ctx.worldFor(stateBotId()).event(String(input.type ?? 'social'), String(input.text ?? '').trim()) } };
    if (method === 'GET' && pathname === '/api/device') return ctx.ok({ device: await ctx.deviceFor(stateBotId()).get() });
    if (method === 'POST' && pathname === '/api/device/transition') {
      const {botId: _botId,...patch}=input;return ctx.ok({ device: await ctx.deviceFor(stateBotId()).transition(parseDevicePatch(patch)) });
    }
    if (method === 'GET' && pathname === '/api/affinity') return ctx.ok({ affinity: await ctx.deps.affinity.list(url.searchParams.get('botId') ?? undefined) });
    if (method === 'POST' && pathname === '/api/affinity/adjust') {
      const parsed=parseAffinityAdjust(input);const row = await ctx.deps.affinity.adjust(parsed.botId,parsed.userId,parsed.delta,parsed.reason,parsed.note);
      return ctx.ok({ affinity: row });
    }
    if(method==='GET'&&pathname==='/api/guild/inventory'){
      const planner=ctx.guildPlanner();
      const botId=typeof url.searchParams.get('botId')==='string'?url.searchParams.get('botId')!:'';
      const guildId=url.searchParams.get('guildId');
      if(!guildId)throw new HttpError(400,'guildId required');
      const result=await planner.inventory(botId||ctx.defaultBotId(),guildId);
      return ctx.ok(result);
    }
    if(method==='POST'&&pathname==='/api/guild/plan'){
      const planner=ctx.guildPlanner();
      const botId=typeof input.botId==='string'?input.botId:'';
      const guildId=typeof input.guildId==='string'?input.guildId:'';
      if(!guildId)throw new HttpError(400,'guildId required');
      const result=await planner.plan(botId||ctx.defaultBotId(),guildId);
      return ctx.ok(result);
    }
    if(method==='POST'&&pathname==='/api/guild/apply'){
      const planner=ctx.guildPlanner();
      const botId=typeof input.botId==='string'?input.botId:'';
      const plan=input.plan;
      if(!plan||typeof plan!=='object'||Array.isArray(plan))throw new HttpError(400,'plan object required');
      const expectedDigest=typeof input.expectedDigest==='string'?input.expectedDigest:'';
      const idempotencyKey=typeof input.idempotencyKey==='string'?input.idempotencyKey:'';
      if(!expectedDigest)throw new HttpError(400,'expectedDigest required');
      if(!idempotencyKey)throw new HttpError(400,'idempotencyKey required');
      const result=await planner.apply(botId||ctx.defaultBotId(),plan as any,expectedDigest,idempotencyKey);
      return ctx.ok(result);
    }

  return undefined;
}
