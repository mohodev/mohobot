import type { IncomingMessage } from 'node:http';
import type { AdminServerOptions } from './server.js';
import type { ApiResult } from './api-types.js';
import { HttpError } from './api-errors.js';
import { handleModelBotRoutes } from './api-routes/models.js';
import { handleMemoryRoutes } from './api-routes/memory.js';
import { handleWorldTaskGuildRoutes } from './api-routes/world.js';
import { handleOperationsRoutes } from './api-routes/ops.js';
import { handleConfigUserRoutes } from './api-routes/config-users.js';
import { handleCharacterMcpRoutes } from './api-routes/characters-mcp.js';
import { handleKnowledgeRoutes } from './api-routes/knowledge.js';
import { AdminAuthService, type AuthenticatedAdmin } from './auth-service.js';
import { can, permissionsFor, type AdminPrincipal, type AdminRole } from './rbac.js';
import { routePolicy, type RoutePolicy } from './route-policy.js';
import { runtimeMetrics } from '../core/runtime-metrics.js';
import type { LogLevel } from '../core/logger.js';
import { defaultPolicy as mcpDefaultPolicy } from '../mcp/permissions.js';
import { ADMIN_ACTIONS, healthSnapshot } from './actions.js';
import { listOperatorToolDescriptors } from '../operator/tools.js';
import { listAudits as listDisclosureAudits } from '../social/disclosure.js';
import { listPersistentDomains, queryPersistentTraces } from './world-isolation.js';
import { RuleDayPlanner } from './day-planner.js';
import { DiscordDeliveryOutbox } from '../discord/outbox.js';
import { behaviorDryRun, parseBehaviorDryRun } from './behavior-dry-run.js';
import { parseAffinityAdjust, parseDevicePatch } from './input-validation.js';
import { importCharacters, type CharacterImportItem } from '../characters/import.js';
import { chatLogQuery } from '../storage/chatlog.js';
import type { DiscordChatDirection } from '../core/discord-chat-log.js';
import type { CharacterCatalog } from '../characters/catalog.js';
import type { AffinityStore } from './affinity.js';
import { DeviceStore } from './device.js';
import { WorldStore } from './world.js';
import type { ModelCatalogStore } from '../ai/model-catalog.js';
import { recommend } from '../ai/model-catalog.js';
import type { ModelOperationsDashboard } from '../ai/model-operations.js';
import type { MemoryAdminService } from '../memory/admin-service.js';
import type { ExpressionMemoryGovernance } from '../memory/expression-memory-governance.js';
import type { ExpressionStatus } from '../memory/expression-memory.js';
import type { SemanticMemoryGovernance } from '../memory/semantic-memory-governance.js';
import type { JargonMemory } from '../memory/jargon-memory.js';
import type { KnowledgeBaseStore } from '../knowledge/store.js';
import type { FutureTaskStore } from '../tasks/future-task.js';
import type { BotControlFacade } from './bot-control.js';
import type { ProviderControl } from './provider-control.js';
import type { GuildPlanner } from './guild-plan.js';
import type { OpsControlFacade } from './ops-control.js';
import { intParam, stringParam, requireOps } from './api-routes/helpers.js';


export interface AdminApiRouterDeps {
  opts: AdminServerOptions;
  auth: AdminAuthService;
  characters: CharacterCatalog;
  affinity: AffinityStore;
  device: DeviceStore;
  catalog: ModelCatalogStore;
  memories: MemoryAdminService;
  expressionGov: ExpressionMemoryGovernance;
  semanticGov: SemanticMemoryGovernance;
  jargon: JargonMemory;
  knowledge: KnowledgeBaseStore;
  modelDashboard: ModelOperationsDashboard;
  futureTasks: FutureTaskStore;
  issueConfirmation: (auth: AuthenticatedAdmin, input: Record<string, unknown>) => ApiResult;
}

export interface AdminApiRouteContext {
  deps: AdminApiRouterDeps;
  ok(value: Record<string, unknown>): ApiResult;
  stateBotId(raw: unknown): string | undefined;
  worldFor(botId: string | undefined): WorldStore;
  deviceFor(botId: string | undefined): DeviceStore;
  providers(): ProviderControl;
  control(): BotControlFacade;
  guildPlanner(): GuildPlanner;
  defaultBotId(): string;
  role(value: unknown): AdminRole;
  assignableRole(principal: AdminPrincipal, value: unknown): AdminRole;
}

export interface AdminApiRouteRequest {
  method: string;
  pathname: string;
  url: URL;
  input: Record<string, unknown>;
  auth: AuthenticatedAdmin;
  token: string;
  stateBotId(): string | undefined;
}

const ROLES = new Set<AdminRole>(['viewer', 'operator', 'admin', 'developer']);

/**
 * Authenticated Admin API dispatcher. Authentication and RoutePolicy remain
 * in AdminServer; this class owns endpoint behavior and domain service calls.
 */
export class AdminApiRouter {
  readonly #deps: AdminApiRouterDeps;

  constructor(deps: AdminApiRouterDeps) {
    this.#deps = deps;
  }

  #stateBotId(raw: unknown): string | undefined {
    const ids = this.#deps.opts.snapshots().map((snapshot) => snapshot.id);
    if (typeof raw === 'string' && raw.trim()) {
      if (ids.length > 0 && !ids.includes(raw)) throw new HttpError(404, 'bot not found');
      return raw;
    }
    if (ids.length === 1) return ids[0];
    if (ids.length === 0) return undefined;
    throw new HttpError(400, 'botId required when multiple bots are configured');
  }
  #worldFor(botId: string | undefined): WorldStore { return new WorldStore(this.#deps.opts.rootDir, botId); }
  #deviceFor(botId: string | undefined): DeviceStore { return new DeviceStore(this.#deps.opts.rootDir, botId); }
  #providers(): ProviderControl {
    if (!this.#deps.opts.providers) throw new HttpError(409, 'provider control unavailable');
    return this.#deps.opts.providers;
  }
  #control(): BotControlFacade {
    if (!this.#deps.opts.botControl) throw new HttpError(409, 'bot control unavailable');
    return this.#deps.opts.botControl;
  }
  #guildPlanner(): GuildPlanner {
    if (!this.#deps.opts.guildPlanner) throw new HttpError(409, 'guild planner unavailable');
    return this.#deps.opts.guildPlanner;
  }
  #defaultBotId(): string {
    const ids = this.#deps.opts.snapshots().map((snapshot) => snapshot.id);
    if (ids.length === 1) return ids[0]!;
    if (ids.length === 0) throw new HttpError(409, 'no bots available');
    throw new HttpError(400, 'botId required when multiple bots are configured');
  }
  #role(value: unknown): AdminRole {
    const role = String(value ?? '');
    if (!ROLES.has(role as AdminRole)) throw new HttpError(400, 'invalid role');
    return role as AdminRole;
  }
  #assignableRole(principal: AdminPrincipal, value: unknown): AdminRole {
    const role = this.#role(value);
    const ranks: Record<AdminRole, number> = { viewer: 0, operator: 1, admin: 2, developer: 3 };
    if (ranks[role] > ranks[principal.role]) throw new HttpError(403, 'cannot assign higher role');
    return role;
  }
  #ok(value: Record<string, unknown>): ApiResult { return { status: 200, body: { ok: true, ...value } }; }

  #routeContext(): AdminApiRouteContext {
    return {
      deps: this.#deps,
      ok: (value) => this.#ok(value),
      stateBotId: (raw) => this.#stateBotId(raw),
      worldFor: (botId) => this.#worldFor(botId),
      deviceFor: (botId) => this.#deviceFor(botId),
      providers: () => this.#providers(),
      control: () => this.#control(),
      guildPlanner: () => this.#guildPlanner(),
      defaultBotId: () => this.#defaultBotId(),
      role: (value) => this.#role(value),
      assignableRole: (principal, value) => this.#assignableRole(principal, value),
    };
  }

  async handle(req: IncomingMessage, url: URL, input: Record<string, unknown>, auth: AuthenticatedAdmin, policy: RoutePolicy, token: string): Promise<ApiResult> {
    const method = req.method ?? 'GET';
    const pathname = url.pathname;
    const stateBotId = () => this.#stateBotId(method === 'GET' ? url.searchParams.get('botId') : input.botId);
    const routeRequest: AdminApiRouteRequest = { method, pathname, url, input, auth, token, stateBotId };
    const routeContext = this.#routeContext();
    if (method === 'GET' && pathname === '/api/auth/me') return this.#ok({ auth, permissions: permissionsFor(auth.principal.role) });
    if (method === 'POST' && pathname === '/api/auth/logout') { await this.#deps.auth.revokeSession(token); return this.#ok({ loggedOut: true }); }
    if (method === 'GET' && pathname === '/api/auth/sessions') return this.#ok({ sessions: await this.#deps.auth.listSessions() });
    if(method==='GET'&&pathname==='/api/auth/temporary-tokens')return this.#ok({tokens:await this.#deps.auth.listTemporaryTokens()});
    if(method==='POST'&&pathname==='/api/auth/temporary-tokens'){const role=this.#role(input.role);if(!can(auth.principal,'tokens.create'))throw new HttpError(403,'forbidden');const ranks:Record<AdminRole,number>={viewer:0,operator:1,admin:2,developer:3};if(ranks[role]>ranks[auth.principal.role])throw new HttpError(403,'cannot create higher-role token');const ttlMinutes=Number(input.ttlMinutes);if(!Number.isSafeInteger(ttlMinutes))throw new HttpError(400,'ttlMinutes required');const created=await this.#deps.auth.createTemporaryToken({label:String(input.label??''),role,createdBy:auth.principal.id,ttlMs:ttlMinutes*60_000});return{status:201,body:{ok:true,...created}};}
    const tempTokenMatch=pathname.match(/^\/api\/auth\/temporary-tokens\/([^/]+)$/);if(method==='DELETE'&&tempTokenMatch){if(!await this.#deps.auth.revokeTemporaryToken(decodeURIComponent(tempTokenMatch[1]!)))throw new HttpError(404,'temporary token not found');return this.#ok({revoked:true});}
    const sessionMatch = pathname.match(/^\/api\/auth\/sessions\/([^/]+)$/);
    if (method === 'DELETE' && sessionMatch) {
      const revoked = await this.#deps.auth.revokeSessionById(decodeURIComponent(sessionMatch[1]!));
      if (!revoked) throw new HttpError(404, 'session not found');
      return this.#ok({ revoked: true });
    }
    if (method === 'POST' && pathname === '/api/confirmations') return this.#deps.issueConfirmation(auth, input);
    if (method === 'GET' && pathname === '/api/metrics') return this.#ok({ metrics: runtimeMetrics.snapshot() });
    if(method==='GET'&&pathname==='/api/logs'){
      if(!this.#deps.opts.logs)throw new HttpError(409,'log buffer unavailable');
      const level=stringParam(url,'level');if(level&&!['trace','debug','info','warn','error','fatal'].includes(level))throw new HttpError(400,'invalid level');
      const component=stringParam(url,'component');if(component&&component.length>64)throw new HttpError(400,'invalid component');
      const after=intParam(url,'after');const limit=intParam(url,'limit');if(limit!==undefined&&(limit<1||limit>500))throw new HttpError(400,'invalid limit');
      return this.#ok({logs:this.#deps.opts.logs.query({after,limit,level:level as LogLevel|undefined,component})});
    }
    if (method === 'GET' && pathname === '/api/status') return this.#ok({ now: new Date().toISOString(), bots: this.#deps.opts.snapshots() });
    if(method==='GET'&&pathname==='/api/debug/chat/capabilities'){if(!this.#deps.opts.debugChat)throw new HttpError(409,'debug chat unavailable');return this.#ok({capabilities:this.#deps.opts.debugChat.capabilities()});}
    if(method==='POST'&&pathname==='/api/debug/chat'){if(!this.#deps.opts.debugChat)throw new HttpError(409,'debug chat unavailable');const botId=typeof input.botId==='string'?input.botId:'';const content=typeof input.content==='string'?input.content:'';const result=await this.#deps.opts.debugChat.chat({actorId:auth.principal.id,botId,content,task:'admin'});return this.#ok({reply:result});}
    const modelsRoute = await handleModelBotRoutes(routeContext, routeRequest);
    if (modelsRoute) return modelsRoute;
    const opsRoute = await handleOperationsRoutes(routeContext, routeRequest);
    if (opsRoute) return opsRoute;
    const configUsersRoute = await handleConfigUserRoutes(routeContext, routeRequest);
    if (configUsersRoute) return configUsersRoute;
    const charactersMcpRoute = await handleCharacterMcpRoutes(routeContext, routeRequest);
    if (charactersMcpRoute) return charactersMcpRoute;
    const memoryRoute = await handleMemoryRoutes(routeContext, routeRequest);
    if (memoryRoute) return memoryRoute;
    if(method==='POST'&&pathname==='/api/behavior/dry-run'){const dry=parseBehaviorDryRun(input);const[world,device,affinity]=await Promise.all([this.#worldFor(this.#stateBotId(dry.botId)).get(),this.#deviceFor(this.#stateBotId(dry.botId)).get(),this.#deps.affinity.get(dry.botId,dry.userId)]);return this.#ok({result:behaviorDryRun(dry,{world,device,affinity})});}
    const knowledgeRoute = await handleKnowledgeRoutes(routeContext, routeRequest);
    if (knowledgeRoute) return knowledgeRoute;
    const worldRoute = await handleWorldTaskGuildRoutes(routeContext, routeRequest);
    if (worldRoute) return worldRoute;
    if(method==='GET'&&pathname==='/api/social/disclosure-audit'){
      const limit=intParam(url,'limit')??50;if(!Number.isSafeInteger(limit)||limit<1||limit>200)throw new HttpError(400,'invalid limit');
      const botId=stringParam(url,'botId');
      return this.#ok({entries:await listDisclosureAudits(this.#deps.opts.storage,botId||undefined,limit)});
    }
    throw new HttpError(403, `handler missing for policy ${policy.action}`);
  }


}
