import type { ApiResult } from '../api-types.js';
import type { AdminApiRouteContext, AdminApiRouteRequest } from '../api-router.js';
import { HttpError } from '../api-errors.js';
import { ADMIN_ACTIONS, healthSnapshot } from '../actions.js';
import { runtimeMetrics } from '../../core/runtime-metrics.js';
import type { LogLevel } from '../../core/logger.js';
import { listOperatorToolDescriptors } from '../../operator/tools.js';
import { chatLogQuery } from '../../storage/chatlog.js';
import type { DiscordChatDirection } from '../../core/discord-chat-log.js';
import { intParam, stringParam, requireOps } from './helpers.js';

export async function handleOperationsRoutes(ctx: AdminApiRouteContext, route: AdminApiRouteRequest): Promise<ApiResult | undefined> {
  const { method, pathname, url, input, auth } = route;
    if (method === 'GET' && pathname === '/api/admin/actions') return ctx.ok({ actions: ADMIN_ACTIONS });
    if (method === 'GET' && pathname === '/api/admin/audit') {
      const audit=await requireOps(ctx.deps.opts.ops).listAudit({limit:intParam(url,'limit'),offset:intParam(url,'offset'),actor:stringParam(url,'actor'),action:stringParam(url,'action'),outcome:stringParam(url,'outcome') as 'allowed'|'denied'|undefined,method:stringParam(url,'method'),status:intParam(url,'status'),from:intParam(url,'from'),to:intParam(url,'to')});
      return ctx.ok({ audit });
    }
    if(method==='GET'&&pathname==='/api/ops/sessions'){const sessions=await requireOps(ctx.deps.opts.ops).listSessions({limit:intParam(url,'limit'),offset:intParam(url,'offset'),botId:stringParam(url,'botId'),channelId:stringParam(url,'channelId'),userId:stringParam(url,'userId')});return ctx.ok({sessions});}
    if(method==='GET'&&pathname==='/api/ops/chat-log'){const channelId=stringParam(url,'channelId');if(!channelId)throw new HttpError(400,'channelId required');const limit=intParam(url,'limit')??50;if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new HttpError(400,'invalid limit');const botId=stringParam(url,'botId');return ctx.ok({messages:chatLogQuery(channelId,limit,botId).reverse()});}
    if(method==='GET'&&pathname==='/api/ops/discord-chat-log'){
      const chatLog=ctx.deps.opts.discordChatLog;if(!chatLog)throw new HttpError(409,'discord chat log unavailable');
      const direction=stringParam(url,'direction');if(direction&&direction!=='in'&&direction!=='out')throw new HttpError(400,'invalid direction');
      const limit=intParam(url,'limit');if(limit!==undefined&&(limit<1||limit>200))throw new HttpError(400,'invalid limit');
      return ctx.ok({messages:chatLog.query({limit,direction:direction as DiscordChatDirection|undefined,channelId:stringParam(url,'channelId'),botId:stringParam(url,'botId')})});
    }
    if(method==='GET'&&pathname==='/api/ops/operator-audit'){
      const limit=intParam(url,'limit')??50;if(!Number.isSafeInteger(limit)||limit<1||limit>200)throw new HttpError(400,'invalid limit');
      const records=await ctx.deps.opts.storage.query<any>({prefix:'plugin:',limit:500});
      const entries=records
        .filter((r:any)=>typeof r.key==='string'&&(r.key.endsWith(':operator:audit')||r.key.endsWith('operator:audit')))
        .flatMap((r:any)=>Array.isArray(r.value)?r.value:[])
        .sort((a:any,b:any)=>(b?.ts??0)-(a?.ts??0))
        .slice(0,limit);
      return ctx.ok({entries});
    }
    if(method==='GET'&&pathname==='/api/ops/operator-tools'){
      return ctx.ok({tools:listOperatorToolDescriptors()});
    }
    const opsSession=pathname.match(/^\/api\/ops\/sessions\/(.+)$/);if(method==='DELETE'&&opsSession){await requireOps(ctx.deps.opts.ops).deleteSession(decodeURIComponent(opsSession[1]!));return ctx.ok({deleted:true});}
    if(method==='GET'&&pathname==='/api/tasks')return ctx.ok({tasks:ctx.deps.opts.taskControl?{items:ctx.deps.opts.taskControl.list()} : requireOps(ctx.deps.opts.ops).listTasks({limit:intParam(url,'limit'),offset:intParam(url,'offset')})});
    const taskAction=pathname.match(/^\/api\/tasks\/([^/]+)\/(pause|resume|run)$/);if(method==='POST'&&taskAction){const control=ctx.deps.opts.taskControl;if(!control)throw new HttpError(409,'task control unavailable');const id=decodeURIComponent(taskAction[1]!);const action=taskAction[2]!;const task=action==='pause'?control.pause(id):action==='resume'?control.resume(id):await control.runNow(id);return ctx.ok({task});}
    if (method === 'GET' && pathname === '/api/admin/health') return ctx.ok({ health: healthSnapshot(ctx.deps.opts.snapshots()) });

  return undefined;
}
