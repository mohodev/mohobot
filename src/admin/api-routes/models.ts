import type { ApiResult } from '../api-types.js';
import type { AdminApiRouteContext, AdminApiRouteRequest } from '../api-router.js';
import { recommend } from '../../ai/model-catalog.js';
import { HttpError } from '../api-errors.js';

export async function handleModelBotRoutes(ctx: AdminApiRouteContext, route: AdminApiRouteRequest): Promise<ApiResult | undefined> {
  const { method, pathname, url, input, auth } = route;
  const stateBotId = route.stateBotId;
    if (method === 'GET' && pathname === '/api/models') {
      const catalog = await ctx.deps.catalog.get();
      const task = url.searchParams.get('task');
      return ctx.ok({ catalog, recommendations: task ? recommend(catalog, task) : undefined });
    }
    if (method === 'GET' && pathname === '/api/models/health') return ctx.ok({ health: await ctx.deps.opts.modelHealth?.() ?? ctx.deps.opts.botControl?.modelHealth() ?? { configured: false } });
    if(method==='GET'&&pathname==='/api/models/dashboard')return ctx.ok({dashboard:ctx.deps.modelDashboard.overview()});
    const modelUsageMatch=pathname.match(/^\/api\/models\/usage\/([^/]+)$/);if(method==='GET'&&modelUsageMatch){const detail=await ctx.deps.modelDashboard.botUsage(decodeURIComponent(modelUsageMatch[1]!));if(!detail)throw new HttpError(404,'bot not found');return ctx.ok({usage:detail});}
    const providerHealthMatch=pathname.match(/^\/api\/models\/health\/([^/]+)$/);if(method==='GET'&&providerHealthMatch){const detail=ctx.deps.modelDashboard.providerHealth(decodeURIComponent(providerHealthMatch[1]!));if(!detail)throw new HttpError(404,'provider not found');return ctx.ok({health:detail});}
    if(method==='GET'&&pathname==='/api/providers')return ctx.ok({providers:ctx.providers().list()});
    if(method==='GET'&&pathname==='/api/extensions')return ctx.ok({extensions:ctx.deps.opts.extensions?.list()??{providers:[],gateways:[],storages:[],memories:[]}});
    const providerProbe=pathname.match(/^\/api\/providers\/([^/]+)\/probe$/);if(method==='POST'&&providerProbe)return ctx.ok({probe:await ctx.providers().probe(decodeURIComponent(providerProbe[1]!))});
    if (method === 'GET' && pathname === '/api/bots') return ctx.ok({ bots: ctx.control().list() });
    const botMatch = pathname.match(/^\/api\/bots\/([^/]+)$/);
    if (method === 'GET' && botMatch) return ctx.ok({ bot: ctx.control().get(decodeURIComponent(botMatch[1]!)) });
    const gatewayMatch = pathname.match(/^\/api\/bots\/([^/]+)\/gateway$/);
    if (method === 'GET' && gatewayMatch) return ctx.ok({ gateway: ctx.control().gateway(decodeURIComponent(gatewayMatch[1]!)) });
    const pluginsMatch = pathname.match(/^\/api\/bots\/([^/]+)\/plugins$/);
    if (method === 'GET' && pluginsMatch) return ctx.ok({ plugins: ctx.control().plugins(decodeURIComponent(pluginsMatch[1]!)) });
    const restartMatch = pathname.match(/^\/api\/bots\/([^/]+)\/restart$/);
    if (method === 'POST' && restartMatch) return ctx.ok({ bot: await ctx.control().restart(decodeURIComponent(restartMatch[1]!)) });
    const reloadMatch = pathname.match(/^\/api\/bots\/([^/]+)\/plugins\/([^/]+)\/reload$/);
    if (method === 'POST' && reloadMatch) return ctx.ok({ plugin: await ctx.control().reloadPlugin(decodeURIComponent(reloadMatch[1]!), decodeURIComponent(reloadMatch[2]!)) });

  return undefined;
}
