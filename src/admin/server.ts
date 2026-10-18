import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import type { BotSnapshot } from '../bot/runtime.js';
import { CharacterCatalog } from '../characters/catalog.js';
import { importCharacters, type CharacterImportItem } from '../characters/import.js';
import { CrossChatError, type CrossChatInput, type CrossChatResult } from '../characters/cross-chat.js';
import { defaultPolicy as mcpDefaultPolicy } from '../mcp/permissions.js';
import { McpError } from '../mcp/types.js';
import type { McpManager } from '../mcp/manager.js';
import type { Logger, LogLevel } from '../core/logger.js';
import type { LogBuffer } from '../core/log-buffer.js';
import type { DiscordChatLogBuffer, DiscordChatDirection } from '../core/discord-chat-log.js';
import { runtimeMetrics } from '../core/runtime-metrics.js';
import{MemoryAdminService}from'../memory/admin-service.js';
import{JargonMemory}from'../memory/jargon-memory.js';
import{ExpressionMemoryGovernance}from'../memory/expression-memory-governance.js';
import type{ExpressionStatus}from'../memory/expression-memory.js';
import{KnowledgeBaseStore}from'../knowledge/store.js';
import type { Storage } from '../storage/types.js';
import { chatLogQuery } from '../storage/chatlog.js';
import { ModelCatalogStore, recommend } from '../ai/model-catalog.js';
import { ModelOperationsDashboard } from '../ai/model-operations.js';
import { ADMIN_ACTIONS, healthSnapshot, type AuditEntry } from './actions.js';
import { AffinityStore } from './affinity.js';
import { AdminAuthError, AdminAuthService, type AuthenticatedAdmin } from './auth-service.js';
import { ConfirmationStore } from './confirmation.js';
import { RuleDayPlanner } from './day-planner.js';
import { DeviceStore } from './device.js';
import { can, permissionsFor, type AdminPrincipal, type AdminRole } from './rbac.js';
import { BotControlError, type BotControlFacade } from './bot-control.js';
import { routePolicy, type RoutePolicy } from './route-policy.js';
import { OpsControlError, type OpsControlFacade } from './ops-control.js';
import { listOperatorToolDescriptors } from '../operator/tools.js';
import {TaskControlError,type TaskControlFacade}from'./task-control.js';
import { ProviderControlError,type ProviderControl } from './provider-control.js';
import type { ExtensionsControl } from './extensions-control.js';
import{DebugChatError,type DebugChatFacade}from'./debug-chat.js';
import { WorldStore } from './world.js';
import{behaviorDryRun,parseBehaviorDryRun}from'./behavior-dry-run.js';
import{parseAffinityAdjust,parseDevicePatch}from'./input-validation.js';
import type{GuildPlanner}from'./guild-plan.js';
import{listAudits as listDisclosureAudits}from'../social/disclosure.js';
import { FutureTaskStore } from '../tasks/future-task.js';
import { listDomains, queryTraces } from './world-isolation.js';
import { DiscordDeliveryOutbox } from '../discord/outbox.js';

export interface ConfigPublicationAdapter {
  get(): Promise<unknown>;
  publish(input: Record<string, unknown>, principal: AdminPrincipal): Promise<unknown>;
  acknowledge?(input: any,principal:AdminPrincipal):Promise<unknown>;
  rollback?(input:any,principal:AdminPrincipal):Promise<unknown>;
  recordActivation?(input: Record<string, unknown>, principal: AdminPrincipal): Promise<unknown>;
  activationReceipts?(scope: string | undefined): Promise<unknown>;
}

export interface AdminServerOptions {
  rootDir: string;
  host: string;
  port: number;
  token: string;
  logger: Logger;
  storage: Storage;
  snapshots: () => BotSnapshot[];
  configPublication?: ConfigPublicationAdapter;
  modelHealth?: () => Promise<unknown>;
  botControl?: BotControlFacade;
  ops?: OpsControlFacade;
  logs?: LogBuffer;
  discordChatLog?: DiscordChatLogBuffer;
  providers?: ProviderControl;
  extensions?: ExtensionsControl;
  debugChat?: DebugChatFacade;
  taskControl?: TaskControlFacade;
  /** Cross-character chat runner (resolved provider injected by the host). */
  crossChat?: (input: CrossChatInput & { botId?: string }) => Promise<CrossChatResult>;
  /** MCP client manager; absent when `mcp.enabled` is false. */
  mcp?: McpManager;
  /** Guild planner; absent when no gateway supports guild administration. */
  guildPlanner?: GuildPlanner;
}

interface ApiResult { status: number; body: unknown }
interface AuditRecord extends AuditEntry { method: string; path: string; status: number }

const BOOTSTRAP_USERNAME = 'bootstrap';
const AUDIT_PREFIX = 'admin-audit:';
const ROLES = new Set<AdminRole>(['viewer', 'operator', 'admin', 'developer']);

function securityHeaders(): Record<string, string> {
  return {
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'",
    'cross-origin-opener-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  };
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const data = JSON.stringify(value);
  res.writeHead(status, { ...securityHeaders(), 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new HttpError(400, 'request body too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'invalid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'JSON object required');
  return parsed as Record<string, unknown>;
}

function bearer(req: IncomingMessage): string {
  return req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? '';
}

function intParam(url:URL,name:string):number|undefined{const raw=url.searchParams.get(name);if(raw===null)return undefined;if(!/^\d+$/.test(raw))throw new HttpError(400,`invalid ${name}`);return Number(raw);}
function stringParam(url:URL,name:string):string|undefined{return url.searchParams.get(name)??undefined;}
function requireOps(ops:OpsControlFacade|undefined):OpsControlFacade{if(!ops)throw new HttpError(409,'operations control unavailable');return ops;}

function loopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  return value === 'localhost' || value === '::1' || value === '::ffff:127.0.0.1' || /^127(?:\.\d{1,3}){3}$/.test(value);
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const a = crypto.createHash('sha256').update(left).digest();
  const b = crypto.createHash('sha256').update(right).digest();
  return crypto.timingSafeEqual(a, b) && left.length === right.length;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export class AdminServer {
  readonly #opts: AdminServerOptions;
  readonly #auth: AdminAuthService;
  readonly #confirmations = new ConfirmationStore();
  readonly #characters: CharacterCatalog;
  readonly #world: WorldStore;
  readonly #affinity: AffinityStore;
  readonly #device: DeviceStore;
  readonly #catalog: ModelCatalogStore;
  readonly #memories:MemoryAdminService;
  readonly #expressionGov:ExpressionMemoryGovernance;
  readonly #jargon:JargonMemory;
  readonly #knowledge:KnowledgeBaseStore;
  readonly #modelDashboard:ModelOperationsDashboard;
  readonly #futureTasks:FutureTaskStore;
  #server?: http.Server;

  /** Select a bot-owned state store. Legacy no-bot deployments retain their old path. */
  #stateBotId(raw: unknown): string | undefined {
    const ids = this.#opts.snapshots().map((snapshot) => snapshot.id);
    if (typeof raw === 'string' && raw.trim()) {
      if (ids.length > 0 && !ids.includes(raw)) throw new HttpError(404, 'bot not found');
      return raw;
    }
    if (ids.length === 1) return ids[0];
    if (ids.length === 0) return undefined;
    throw new HttpError(400, 'botId required when multiple bots are configured');
  }
  #worldFor(botId: string | undefined): WorldStore { return new WorldStore(this.#opts.rootDir, botId); }
  #deviceFor(botId: string | undefined): DeviceStore { return new DeviceStore(this.#opts.rootDir, botId); }

  constructor(opts: AdminServerOptions) {
    this.#opts = opts;
    this.#auth = new AdminAuthService({ storage: opts.storage });
    this.#characters = new CharacterCatalog(opts.rootDir);
    this.#world = new WorldStore(opts.rootDir);
    this.#affinity = new AffinityStore(opts.rootDir);
    this.#device = new DeviceStore(opts.rootDir);
    this.#catalog = new ModelCatalogStore(opts.rootDir);
    this.#memories=new MemoryAdminService(opts.storage);
    this.#expressionGov=new ExpressionMemoryGovernance({storage:opts.storage,logger:opts.logger});
    this.#jargon=new JargonMemory({storage:opts.storage,logger:opts.logger});
    this.#knowledge=new KnowledgeBaseStore(opts.storage);
    this.#modelDashboard=new ModelOperationsDashboard({snapshots:opts.snapshots,usage:{totals:(botId,days)=>opts.snapshots().find((snapshot)=>snapshot.id===botId)?.usage?.totals(botId,days)??Promise.resolve([])}});
    this.#futureTasks=new FutureTaskStore(opts.storage);
  }

  get port(): number | undefined {
    const address = this.#server?.address();
    return address && typeof address === 'object' ? address.port : undefined;
  }

  async start(): Promise<void> {
    if (this.#server) return;
    if (!loopbackHost(this.#opts.host)) throw new Error('admin server must bind to a loopback host; use an HTTPS reverse proxy for remote access');
    this.#server = http.createServer((req, res) => void this.#handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.#server!.once('error', reject);
      this.#server!.listen(this.#opts.port, this.#opts.host, resolve);
    });
    this.#opts.logger.info({ host: this.#opts.host, port: this.port }, 'admin WebUI ready');
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    let pathname = '/';
    let auditAuth: AuthenticatedAdmin | undefined;
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      pathname = url.pathname;
      if (!pathname.startsWith('/api/')) return await this.#static(res, pathname);
      const input = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? await readBody(req) : {};

      if (method === 'POST' && (pathname === '/api/auth/bootstrap/session' || pathname === '/api/auth/session')) {
        return await this.#bootstrap(req, res, method, pathname);
      }
      if (method === 'POST' && pathname === '/api/auth/login') return await this.#login(res, input, method, pathname);

      const token = bearer(req);
      const authenticated = await this.#auth.authenticate(token);
      auditAuth = authenticated;
      if (!authenticated) {
        await this.#audit(undefined, method, pathname, 401, 'denied', 'authentication required');
        return json(res, 401, { ok: false, error: 'unauthorized' });
      }

      const policy = routePolicy(method, pathname);
      if (!policy) {
        await this.#audit(authenticated, method, pathname, 403, 'denied', 'route policy missing');
        return json(res, 403, { ok: false, error: 'forbidden' });
      }
      if (policy.permission && !can(authenticated.principal, policy.permission)) {
        await this.#audit(authenticated, method, pathname, 403, 'denied', `permission denied: ${policy.permission}`);
        return json(res, 403, { ok: false, error: 'forbidden' });
      }
      if (policy.confirmation) {
        const nonce = typeof req.headers['x-admin-confirmation'] === 'string' ? req.headers['x-admin-confirmation'] : '';
        const valid = nonce && policy.permission && this.#confirmations.consume(nonce, {
          principal: authenticated.principal,
          permission: policy.permission,
          action: `${policy.action}:${method}:${pathname}`,
          payload: input,
        });
        if (!valid) {
          await this.#audit(authenticated, method, pathname, 409, 'denied', `confirmation required: ${policy.action}`);
          return json(res, 409, { ok: false, error: 'confirmation required' });
        }
      }

      const result = await this.#api(req, url, input, authenticated, policy, token);
      await this.#auditSafely(authenticated, method, pathname, result.status, 'allowed', policy.action);
      json(res, result.status, result.body);
    } catch (error) {
      const mapped = this.#mapError(error);
      this.#opts.logger.warn({ method, path: pathname, error: mapped.message }, 'admin request failed');
      await this.#audit(auditAuth, method, pathname, mapped.status, 'denied', mapped.message).catch(() => {});
      json(res, mapped.status, { ok: false, error: mapped.message });
    }
  }

  async #bootstrap(req: IncomingMessage, res: ServerResponse, method: string, pathname: string): Promise<void> {
    const supplied = bearer(req) || (typeof req.headers['x-admin-token'] === 'string' ? req.headers['x-admin-token'] : '');
    if (!this.#opts.token || !supplied || !timingSafeStringEqual(supplied, this.#opts.token)) {
      await this.#audit(undefined, method, pathname, 401, 'denied', 'invalid master token');
      return json(res, 401, { ok: false, error: 'unauthorized' });
    }
    const initialPassword = crypto.createHash('sha256').update(`bootstrap:${this.#opts.token}`).digest('base64url');
    const result = await this.#auth.bootstrapSession({ username: BOOTSTRAP_USERNAME, initialPassword });
    await this.#audit(result.auth, method, pathname, 201, 'allowed', 'bootstrap session exchanged');
    json(res, 201, { ok: true, token: result.token, auth: result.auth });
  }

  async #login(res: ServerResponse, input: Record<string, unknown>, method: string, pathname: string): Promise<void> {
    try {
      const result = await this.#auth.login(String(input.username ?? ''), String(input.password ?? ''));
      await this.#audit(result.auth, method, pathname, 201, 'allowed', 'password login');
      json(res, 201, { ok: true, token: result.token, auth: result.auth });
    } catch (error) {
      const status = error instanceof AdminAuthError && error.code === 'locked' ? 409 : 401;
      await this.#audit(undefined, method, pathname, status, 'denied', error instanceof AdminAuthError ? error.code : 'login failed');
      json(res, status, { ok: false, error: status === 409 ? 'account locked' : 'invalid credentials' });
    }
  }

  async #api(req: IncomingMessage, url: URL, input: Record<string, unknown>, auth: AuthenticatedAdmin, policy: RoutePolicy, token: string): Promise<ApiResult> {
    const method = req.method ?? 'GET';
    const pathname = url.pathname;
    const stateBotId = () => this.#stateBotId(method === 'GET' ? url.searchParams.get('botId') : input.botId);
    if (method === 'GET' && pathname === '/api/auth/me') return this.#ok({ auth, permissions: permissionsFor(auth.principal.role) });
    if (method === 'POST' && pathname === '/api/auth/logout') { await this.#auth.revokeSession(token); return this.#ok({ loggedOut: true }); }
    if (method === 'GET' && pathname === '/api/auth/sessions') return this.#ok({ sessions: await this.#auth.listSessions() });
    if(method==='GET'&&pathname==='/api/auth/temporary-tokens')return this.#ok({tokens:await this.#auth.listTemporaryTokens()});
    if(method==='POST'&&pathname==='/api/auth/temporary-tokens'){const role=this.#role(input.role);if(!can(auth.principal,'tokens.create'))throw new HttpError(403,'forbidden');const ranks:Record<AdminRole,number>={viewer:0,operator:1,admin:2,developer:3};if(ranks[role]>ranks[auth.principal.role])throw new HttpError(403,'cannot create higher-role token');const ttlMinutes=Number(input.ttlMinutes);if(!Number.isSafeInteger(ttlMinutes))throw new HttpError(400,'ttlMinutes required');const created=await this.#auth.createTemporaryToken({label:String(input.label??''),role,createdBy:auth.principal.id,ttlMs:ttlMinutes*60_000});return{status:201,body:{ok:true,...created}};}
    const tempTokenMatch=pathname.match(/^\/api\/auth\/temporary-tokens\/([^/]+)$/);if(method==='DELETE'&&tempTokenMatch){if(!await this.#auth.revokeTemporaryToken(decodeURIComponent(tempTokenMatch[1]!)))throw new HttpError(404,'temporary token not found');return this.#ok({revoked:true});}
    const sessionMatch = pathname.match(/^\/api\/auth\/sessions\/([^/]+)$/);
    if (method === 'DELETE' && sessionMatch) {
      const revoked = await this.#auth.revokeSessionById(decodeURIComponent(sessionMatch[1]!));
      if (!revoked) throw new HttpError(404, 'session not found');
      return this.#ok({ revoked: true });
    }
    if (method === 'POST' && pathname === '/api/confirmations') return this.#issueConfirmation(auth, input);
    if (method === 'GET' && pathname === '/api/metrics') return this.#ok({ metrics: runtimeMetrics.snapshot() });
    if(method==='GET'&&pathname==='/api/logs'){
      if(!this.#opts.logs)throw new HttpError(409,'log buffer unavailable');
      const level=stringParam(url,'level');if(level&&!['trace','debug','info','warn','error','fatal'].includes(level))throw new HttpError(400,'invalid level');
      const component=stringParam(url,'component');if(component&&component.length>64)throw new HttpError(400,'invalid component');
      const after=intParam(url,'after');const limit=intParam(url,'limit');if(limit!==undefined&&(limit<1||limit>500))throw new HttpError(400,'invalid limit');
      return this.#ok({logs:this.#opts.logs.query({after,limit,level:level as LogLevel|undefined,component})});
    }
    if (method === 'GET' && pathname === '/api/status') return this.#ok({ now: new Date().toISOString(), bots: this.#opts.snapshots() });
    if(method==='GET'&&pathname==='/api/debug/chat/capabilities'){if(!this.#opts.debugChat)throw new HttpError(409,'debug chat unavailable');return this.#ok({capabilities:this.#opts.debugChat.capabilities()});}
    if(method==='POST'&&pathname==='/api/debug/chat'){if(!this.#opts.debugChat)throw new HttpError(409,'debug chat unavailable');const botId=typeof input.botId==='string'?input.botId:'';const content=typeof input.content==='string'?input.content:'';const result=await this.#opts.debugChat.chat({actorId:auth.principal.id,botId,content,task:'admin'});return this.#ok({reply:result});}
    if (method === 'GET' && pathname === '/api/models') {
      const catalog = await this.#catalog.get();
      const task = url.searchParams.get('task');
      return this.#ok({ catalog, recommendations: task ? recommend(catalog, task) : undefined });
    }
    if (method === 'GET' && pathname === '/api/models/health') return this.#ok({ health: await this.#opts.modelHealth?.() ?? this.#opts.botControl?.modelHealth() ?? { configured: false } });
    if(method==='GET'&&pathname==='/api/models/dashboard')return this.#ok({dashboard:this.#modelDashboard.overview()});
    const modelUsageMatch=pathname.match(/^\/api\/models\/usage\/([^/]+)$/);if(method==='GET'&&modelUsageMatch){const detail=await this.#modelDashboard.botUsage(decodeURIComponent(modelUsageMatch[1]!));if(!detail)throw new HttpError(404,'bot not found');return this.#ok({usage:detail});}
    const providerHealthMatch=pathname.match(/^\/api\/models\/health\/([^/]+)$/);if(method==='GET'&&providerHealthMatch){const detail=this.#modelDashboard.providerHealth(decodeURIComponent(providerHealthMatch[1]!));if(!detail)throw new HttpError(404,'provider not found');return this.#ok({health:detail});}
    if(method==='GET'&&pathname==='/api/providers')return this.#ok({providers:this.#providers().list()});
    if(method==='GET'&&pathname==='/api/extensions')return this.#ok({extensions:this.#opts.extensions?.list()??{providers:[],gateways:[],storages:[],memories:[]}});
    const providerProbe=pathname.match(/^\/api\/providers\/([^/]+)\/probe$/);if(method==='POST'&&providerProbe)return this.#ok({probe:await this.#providers().probe(decodeURIComponent(providerProbe[1]!))});
    if (method === 'GET' && pathname === '/api/bots') return this.#ok({ bots: this.#control().list() });
    const botMatch = pathname.match(/^\/api\/bots\/([^/]+)$/);
    if (method === 'GET' && botMatch) return this.#ok({ bot: this.#control().get(decodeURIComponent(botMatch[1]!)) });
    const gatewayMatch = pathname.match(/^\/api\/bots\/([^/]+)\/gateway$/);
    if (method === 'GET' && gatewayMatch) return this.#ok({ gateway: this.#control().gateway(decodeURIComponent(gatewayMatch[1]!)) });
    const pluginsMatch = pathname.match(/^\/api\/bots\/([^/]+)\/plugins$/);
    if (method === 'GET' && pluginsMatch) return this.#ok({ plugins: this.#control().plugins(decodeURIComponent(pluginsMatch[1]!)) });
    const restartMatch = pathname.match(/^\/api\/bots\/([^/]+)\/restart$/);
    if (method === 'POST' && restartMatch) return this.#ok({ bot: await this.#control().restart(decodeURIComponent(restartMatch[1]!)) });
    const reloadMatch = pathname.match(/^\/api\/bots\/([^/]+)\/plugins\/([^/]+)\/reload$/);
    if (method === 'POST' && reloadMatch) return this.#ok({ plugin: await this.#control().reloadPlugin(decodeURIComponent(reloadMatch[1]!), decodeURIComponent(reloadMatch[2]!)) });
    if (method === 'GET' && pathname === '/api/admin/actions') return this.#ok({ actions: ADMIN_ACTIONS });
    if (method === 'GET' && pathname === '/api/admin/audit') {
      const audit=await requireOps(this.#opts.ops).listAudit({limit:intParam(url,'limit'),offset:intParam(url,'offset'),actor:stringParam(url,'actor'),action:stringParam(url,'action'),outcome:stringParam(url,'outcome') as 'allowed'|'denied'|undefined,method:stringParam(url,'method'),status:intParam(url,'status'),from:intParam(url,'from'),to:intParam(url,'to')});
      return this.#ok({ audit });
    }
    if(method==='GET'&&pathname==='/api/ops/sessions'){const sessions=await requireOps(this.#opts.ops).listSessions({limit:intParam(url,'limit'),offset:intParam(url,'offset'),botId:stringParam(url,'botId'),channelId:stringParam(url,'channelId'),userId:stringParam(url,'userId')});return this.#ok({sessions});}
    if(method==='GET'&&pathname==='/api/ops/chat-log'){const channelId=stringParam(url,'channelId');if(!channelId)throw new HttpError(400,'channelId required');const limit=intParam(url,'limit')??50;if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new HttpError(400,'invalid limit');const botId=stringParam(url,'botId');return this.#ok({messages:chatLogQuery(channelId,limit,botId).reverse()});}
    if(method==='GET'&&pathname==='/api/ops/discord-chat-log'){
      const chatLog=this.#opts.discordChatLog;if(!chatLog)throw new HttpError(409,'discord chat log unavailable');
      const direction=stringParam(url,'direction');if(direction&&direction!=='in'&&direction!=='out')throw new HttpError(400,'invalid direction');
      const limit=intParam(url,'limit');if(limit!==undefined&&(limit<1||limit>200))throw new HttpError(400,'invalid limit');
      return this.#ok({messages:chatLog.query({limit,direction:direction as DiscordChatDirection|undefined,channelId:stringParam(url,'channelId'),botId:stringParam(url,'botId')})});
    }
    if(method==='GET'&&pathname==='/api/ops/operator-audit'){
      const limit=intParam(url,'limit')??50;if(!Number.isSafeInteger(limit)||limit<1||limit>200)throw new HttpError(400,'invalid limit');
      const records=await this.#opts.storage.query<any>({prefix:'plugin:',limit:500});
      const entries=records
        .filter((r:any)=>typeof r.key==='string'&&(r.key.endsWith(':operator:audit')||r.key.endsWith('operator:audit')))
        .flatMap((r:any)=>Array.isArray(r.value)?r.value:[])
        .sort((a:any,b:any)=>(b?.ts??0)-(a?.ts??0))
        .slice(0,limit);
      return this.#ok({entries});
    }
    if(method==='GET'&&pathname==='/api/ops/operator-tools'){
      return this.#ok({tools:listOperatorToolDescriptors()});
    }
    const opsSession=pathname.match(/^\/api\/ops\/sessions\/(.+)$/);if(method==='DELETE'&&opsSession){await requireOps(this.#opts.ops).deleteSession(decodeURIComponent(opsSession[1]!));return this.#ok({deleted:true});}
    if(method==='GET'&&pathname==='/api/tasks')return this.#ok({tasks:this.#opts.taskControl?{items:this.#opts.taskControl.list()} : requireOps(this.#opts.ops).listTasks({limit:intParam(url,'limit'),offset:intParam(url,'offset')})});
    const taskAction=pathname.match(/^\/api\/tasks\/([^/]+)\/(pause|resume|run)$/);if(method==='POST'&&taskAction){const control=this.#opts.taskControl;if(!control)throw new HttpError(409,'task control unavailable');const id=decodeURIComponent(taskAction[1]!);const action=taskAction[2]!;const task=action==='pause'?control.pause(id):action==='resume'?control.resume(id):await control.runNow(id);return this.#ok({task});}
    if (method === 'GET' && pathname === '/api/admin/health') return this.#ok({ health: healthSnapshot(this.#opts.snapshots()) });
    if (method === 'GET' && pathname === '/api/config/publication') return this.#ok({ publication: await this.#opts.configPublication?.get() ?? null });
    if (method === 'POST' && pathname === '/api/config/publish') {
      if (!this.#opts.configPublication) throw new HttpError(409, 'config publication unavailable');
      return this.#ok({ publication: await this.#opts.configPublication.publish(input, auth.principal) });
    }
    if(method==='POST'&&pathname==='/api/config/ack'){if(!this.#opts.configPublication?.acknowledge)throw new HttpError(409,'config acknowledgement unavailable');return this.#ok({publication:await this.#opts.configPublication.acknowledge(input,auth.principal)});}
    if(method==='POST'&&pathname==='/api/config/rollback'){if(!this.#opts.configPublication?.rollback)throw new HttpError(409,'config rollback unavailable');return this.#ok({publication:await this.#opts.configPublication.rollback(input,auth.principal)});}
    if(method==='GET'&&pathname==='/api/config/activation-receipts'){if(!this.#opts.configPublication?.activationReceipts)throw new HttpError(409,'config activation receipts unavailable');const scope=url.searchParams.get('scope');return this.#ok({receipts:await this.#opts.configPublication.activationReceipts(scope===null||scope.trim()===''?undefined:scope)});}
    if(method==='POST'&&pathname==='/api/config/activation-receipt'){if(!this.#opts.configPublication?.recordActivation)throw new HttpError(409,'config activation receipt unavailable');return this.#ok({receipt:await this.#opts.configPublication.recordActivation(input,auth.principal)});}
    if (method === 'GET' && pathname === '/api/admin/users') return this.#ok({ users: await this.#auth.listUsers() });
    if (method === 'POST' && pathname === '/api/admin/users') {
      const role = this.#assignableRole(auth.principal, input.role);
      if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new HttpError(400, 'enabled must be boolean');
      const user = await this.#auth.createUser({ username: String(input.username ?? ''), password: String(input.password ?? ''), role, enabled: input.enabled === undefined ? true : input.enabled });
      return { status: 201, body: { ok: true, user } };
    }
    const userMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
    if (method === 'PATCH' && userMatch) {
      const identifier = decodeURIComponent(userMatch[1]!);
      const target=await this.#auth.resolveUserIdentifier(identifier);if(!target)throw new HttpError(404,'user not found');
      const username=target.normalizedUsername;
      const patch: { username?: string; role?: AdminRole; enabled?: boolean } = {};
      if (input.username !== undefined) patch.username = String(input.username);
      if (input.role !== undefined) {
        if (!can(auth.principal, 'users.role.assign')) throw new HttpError(403, 'forbidden');
        patch.role = this.#assignableRole(auth.principal, input.role);
      }
      if (input.enabled !== undefined) {
        if (!can(auth.principal, 'users.disable')) throw new HttpError(403, 'forbidden');
        if (typeof input.enabled !== 'boolean') throw new HttpError(400, 'enabled must be boolean');
        patch.enabled = input.enabled;
      }
      return this.#ok({ user: await this.#auth.updateUser(username, patch) });
    }
    const passwordMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/password$/);
    if (method === 'POST' && passwordMatch) {
      const identifier=decodeURIComponent(passwordMatch[1]!);const target=await this.#auth.resolveUserIdentifier(identifier);if(!target)throw new HttpError(404,'user not found');
      await this.#auth.changePassword(target.normalizedUsername, String(input.password ?? ''));
      return this.#ok({ changed: true });
    }
    if (method === 'GET' && pathname === '/api/characters') {
      const rows = await this.#characters.list();
      return this.#ok({ characters: rows.map(({ prompt, ...item }) => ({ ...item, promptLength: prompt.length })) });
    }
    const characterMatch=pathname.match(/^\/api\/characters\/([^/]+)$/);
    if(method==='GET'&&characterMatch){const character=await this.#characters.get(decodeURIComponent(characterMatch[1]!));if(!character)throw new HttpError(404,'character not found');return this.#ok({character});}
    if(method==='PUT'&&characterMatch){const id=decodeURIComponent(characterMatch[1]!);const expectedRevision=String(input.expectedRevision??'');if(!/^[a-f0-9]{64}$/.test(expectedRevision))throw new HttpError(400,'expectedRevision required');const saved=await this.#characters.save({id,name:String(input.name??'').trim(),prompt:String(input.prompt??''),source:typeof input.source==='string'?input.source:undefined,expectedRevision});return this.#ok({character:saved});}
    if (method === 'POST' && pathname === '/api/characters') {
      const saved = await this.#characters.save({ id: typeof input.id === 'string' ? input.id : undefined, name: String(input.name ?? '').trim(), prompt: String(input.prompt ?? ''), source: typeof input.source === 'string' ? input.source : undefined });
      return { status: 201, body: { ok: true, character: { ...saved, promptLength: saved.prompt.length } } };
    }
    if (method === 'POST' && pathname === '/api/characters/import') {
      const rawItems = input.items;
      if (!Array.isArray(rawItems)) throw new HttpError(400, 'items must be an array');
      const items: CharacterImportItem[] = rawItems.map((it) => {
        const o = (it ?? {}) as Record<string, unknown>;
        return {
          id: typeof o.id === 'string' ? o.id : undefined,
          name: String(o.name ?? '').trim(),
          prompt: String(o.prompt ?? ''),
          source: typeof o.source === 'string' ? o.source : undefined,
          expectedRevision: typeof o.expectedRevision === 'string' ? o.expectedRevision : undefined,
        };
      });
      const dryRun = input.dryRun === true;
      const onConflict = input.onConflict === 'overwrite' ? 'overwrite' : 'skip';
      const report = await importCharacters(this.#characters, items, { dryRun, onConflict });
      return this.#ok({ report });
    }
    if (method === 'POST' && pathname === '/api/characters/cross-chat') {
      if (!this.#opts.crossChat) throw new HttpError(409, 'cross-chat unavailable');
      const characterIds = input.characterIds;
      if (!Array.isArray(characterIds) || characterIds.length < 2) throw new HttpError(400, 'characterIds requires >= 2 entries');
      const topic = String(input.topic ?? '').trim();
      if (!topic) throw new HttpError(400, 'topic required');
      const result = await this.#opts.crossChat({
        characterIds: characterIds.map((x) => String(x)),
        topic,
        startWith: typeof input.startWith === 'string' ? input.startWith : undefined,
        botId: typeof input.botId === 'string' ? input.botId : undefined,
      });
      return this.#ok({ result });
    }
    if (method === 'GET' && pathname === '/api/mcp/policy') {
      return this.#ok({ rules: mcpDefaultPolicy.rules });
    }
    if (method === 'GET' && pathname === '/api/mcp/tools') {
      if (!this.#opts.mcp) throw new HttpError(409, 'mcp unavailable');
      return this.#ok({ servers: this.#opts.mcp.status(), tools: this.#opts.mcp.tools() });
    }
    if (method === 'GET' && pathname === '/api/mcp/audit') {
      if (!this.#opts.mcp) throw new HttpError(409, 'mcp unavailable');
      return this.#ok({ entries: this.#opts.mcp.audit() });
    }
    if (method === 'POST' && pathname === '/api/mcp/call') {
      if (!this.#opts.mcp) throw new HttpError(409, 'mcp unavailable');
      const server = typeof input.server === 'string' ? input.server : '';
      const tool = typeof input.tool === 'string' ? input.tool.trim() : '';
      if (!server || !tool) throw new HttpError(400, 'server and tool required');
      const rawArgs = input.arguments;
      if (rawArgs !== undefined && (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs))) {
        throw new HttpError(400, 'arguments must be an object');
      }
      const result = await this.#opts.mcp.callTool(server, tool, rawArgs as Record<string, unknown> | undefined, {
        id: auth.principal.id,
        role: auth.principal.role,
      });
      return this.#ok({ result });
    }
    if(method==='GET'&&pathname==='/api/memory/expressions'){
      const botId=url.searchParams.get('botId');if(!botId)throw new HttpError(400,'botId required');
      const userId=stringParam(url,'userId');const statusRaw=stringParam(url,'status');
      if(statusRaw&&!['pending','approved','rejected','superseded'].includes(statusRaw))throw new HttpError(400,'invalid status');
      const records=await this.#expressionGov.list(botId,userId??undefined,statusRaw as ExpressionStatus|undefined);
      return this.#ok({records});
    }
    if(method==='POST'&&pathname==='/api/memory/expressions/approve'){
      const botId=String(input.botId??'');const userId=String(input.userId??'');const id=String(input.id??'');
      if(!botId||!userId||!id)throw new HttpError(400,'botId, userId, and id required');
      const outcome=await this.#expressionGov.approve(botId,userId,id,auth.principal.id);
      return this.#ok({outcome});
    }
    if(method==='POST'&&pathname==='/api/memory/expressions/reject'){
      const botId=String(input.botId??'');const userId=String(input.userId??'');const id=String(input.id??'');
      if(!botId||!userId||!id)throw new HttpError(400,'botId, userId, and id required');
      const outcome=await this.#expressionGov.reject(botId,userId,id,auth.principal.id);
      return this.#ok({outcome});
    }
    if(method==='POST'&&pathname==='/api/memory/expressions/bulk-delete'){
      const botId=String(input.botId??'');if(!botId)throw new HttpError(400,'botId required');
      const userId=typeof input.userId==='string'?input.userId:undefined;
      const channelId=typeof input.channelId==='string'?input.channelId:undefined;
      const before=typeof input.before==='number'&&Number.isFinite(input.before)?input.before:undefined;
      const reason=typeof input.reason==='string'?input.reason:undefined;
      const count=await this.#expressionGov.bulkDelete({botId,userId,channelId,before},auth.principal.id,reason);
      return this.#ok({deleted:count});
    }
    if(method==='GET'&&pathname==='/api/memory/expressions/recycle-bin'){
      const botId=url.searchParams.get('botId');if(!botId)throw new HttpError(400,'botId required');
      const limit=intParam(url,'limit');if(limit!==undefined&&(limit<1||limit>1000))throw new HttpError(400,'invalid limit');
      const records=await this.#expressionGov.recycleBin(botId,limit);
      return this.#ok({records});
    }
    if(method==='POST'&&pathname==='/api/memory/expressions/restore'){
      const botId=String(input.botId??'');const userId=String(input.userId??'');const id=String(input.id??'');
      if(!botId||!userId||!id)throw new HttpError(400,'botId, userId, and id required');
      const outcome=await this.#expressionGov.restore(botId,userId,id,auth.principal.id);
      if(outcome==='invalid')throw new HttpError(409,'record has expired and cannot be restored');
      return this.#ok({outcome});
    }
    if(method==='GET'&&pathname==='/api/memory/expressions/export'){
      const botId=url.searchParams.get('botId');if(!botId)throw new HttpError(400,'botId required');
      const statusRaw=stringParam(url,'status');
      if(statusRaw&&!['pending','approved','rejected','superseded'].includes(statusRaw))throw new HttpError(400,'invalid status');
      const limit=intParam(url,'limit');if(limit!==undefined&&(limit<1||limit>5000))throw new HttpError(400,'invalid limit');
      const jsonl=await this.#expressionGov.exportSanitized(botId,{status:statusRaw as ExpressionStatus|undefined,limit});
      return this.#ok({data:jsonl});
    }
    if(method==='GET'&&pathname==='/api/memory/jargon'){
      const status=stringParam(url,'status');
      if(status&&!['candidate','approved','rejected'].includes(status))throw new HttpError(400,'invalid status');
      return this.#ok({entries:await this.#jargon.list({channelId:stringParam(url,'channelId'),guildId:stringParam(url,'guildId'),status:status as 'candidate'|'approved'|'rejected'|undefined,limit:intParam(url,'limit'),offset:intParam(url,'offset')})});
    }
    if(method==='POST'&&pathname==='/api/memory/jargon/approve'){
      const id=typeof input.id==='string'?input.id:'';if(!id)throw new HttpError(400,'id required');
      return this.#ok({outcome:await this.#jargon.approve(id,auth.principal.id)});
    }
    if(method==='POST'&&pathname==='/api/memory/jargon/reject'){
      const id=typeof input.id==='string'?input.id:'';if(!id)throw new HttpError(400,'id required');
      return this.#ok({outcome:await this.#jargon.reject(id,auth.principal.id)});
    }
    if(method==='GET'&&pathname==='/api/memory'){const scope=url.searchParams.get('scope');if(scope&&!['private','relationship','shared'].includes(scope))throw new HttpError(400,'invalid scope');const rawLimit=url.searchParams.get('limit');const limit=rawLimit===null?undefined:Number(rawLimit);if(limit!==undefined&&(!Number.isSafeInteger(limit)||limit<1||limit>200))throw new HttpError(400,'invalid limit');return this.#ok({memories:await this.#memories.list({botId:url.searchParams.get('botId')||undefined,channelId:url.searchParams.get('channelId')||undefined,userId:url.searchParams.get('userId')||undefined,scope:scope as any,limit})});}
    const memoryMatch=pathname.match(/^\/api\/memory\/([^/]+)$/);if(method==='GET'&&memoryMatch){const memory=await this.#memories.get(decodeURIComponent(memoryMatch[1]!));if(!memory)throw new HttpError(404,'memory not found');return this.#ok({memory});}if(method==='DELETE'&&memoryMatch){const deleted=await this.#memories.delete(decodeURIComponent(memoryMatch[1]!));if(!deleted)throw new HttpError(404,'memory not found');return this.#ok({deleted:true});}
    if(method==='POST'&&pathname==='/api/behavior/dry-run'){const dry=parseBehaviorDryRun(input);const[world,device,affinity]=await Promise.all([this.#worldFor(this.#stateBotId(dry.botId)).get(),this.#deviceFor(this.#stateBotId(dry.botId)).get(),this.#affinity.get(dry.botId,dry.userId)]);return this.#ok({result:behaviorDryRun(dry,{world,device,affinity})});}
    if(method==='GET'&&pathname==='/api/knowledge-bases')return this.#ok({bases:await this.#knowledge.list(intParam(url,'offset')??0,intParam(url,'limit')??50)});
    if(method==='POST'&&pathname==='/api/knowledge-bases')return{status:201,body:{ok:true,base:await this.#knowledge.create({id:typeof input.id==='string'?input.id:undefined,name:String(input.name??''),description:typeof input.description==='string'?input.description:undefined})}};
    const kb=pathname.match(/^\/api\/knowledge-bases\/([^/]+)$/);if(kb){const baseId=decodeURIComponent(kb[1]!);if(method==='GET'){const base=await this.#knowledge.get(baseId);if(!base)throw new HttpError(404,'knowledge base not found');return this.#ok({base});}if(method==='DELETE'){if(!await this.#knowledge.delete(baseId))throw new HttpError(404,'knowledge base not found');return this.#ok({deleted:true});}}
    const docList=pathname.match(/^\/api\/knowledge-bases\/([^/]+)\/documents$/);if(docList){const baseId=decodeURIComponent(docList[1]!);if(method==='GET')return this.#ok({documents:await this.#knowledge.listDocuments(baseId,intParam(url,'offset')??0,intParam(url,'limit')??50)});if(method==='POST')return this.#ok({document:await this.#knowledge.upsertDocument({baseId,id:typeof input.id==='string'?input.id:undefined,name:String(input.name??''),text:String(input.text??'')})});}
    const doc=pathname.match(/^\/api\/knowledge-bases\/([^/]+)\/documents\/([^/]+)$/);if(doc){const baseId=decodeURIComponent(doc[1]!),id=decodeURIComponent(doc[2]!);if(method==='GET'){const document=await this.#knowledge.getDocument(baseId,id);if(!document)throw new HttpError(404,'document not found');return this.#ok({document});}if(method==='DELETE'){if(!await this.#knowledge.deleteDocument(baseId,id))throw new HttpError(404,'document not found');return this.#ok({deleted:true});}}
    const search=pathname.match(/^\/api\/knowledge-bases\/([^/]+)\/search$/);if(method==='GET'&&search)return this.#ok({results:await this.#knowledge.search({baseId:decodeURIComponent(search[1]!),query:String(url.searchParams.get('q')??''),offset:intParam(url,'offset'),limit:intParam(url,'limit')})});
    const bindings=pathname.match(/^\/api\/knowledge-bases\/([^/]+)\/bindings$/);if(bindings){const baseId=decodeURIComponent(bindings[1]!);if(method==='GET')return this.#ok({bindings:await this.#knowledge.bindings(baseId)});if(method==='POST')return this.#ok({binding:await this.#knowledge.bind({baseId,targetType:input.targetType as 'bot'|'character',targetId:String(input.targetId??'')})});}
    const binding=pathname.match(/^\/api\/knowledge-bases\/([^/]+)\/bindings\/([^/]+)\/([^/]+)$/);if(method==='DELETE'&&binding){if(!await this.#knowledge.unbind(decodeURIComponent(binding[1]!),decodeURIComponent(binding[2]!) as 'bot'|'character',decodeURIComponent(binding[3]!)))throw new HttpError(404,'binding not found');return this.#ok({deleted:true});}
    if (method === 'GET' && pathname === '/api/world') return this.#ok({ world: await this.#worldFor(stateBotId()).get() });
    if(method==='GET'&&pathname==='/api/world/schedule'){const world=await this.#worldFor(this.#stateBotId(stringParam(url,'botId'))).get();return this.#ok({schedule:world.schedule,domains:listDomains()});}
    if(method==='GET'&&pathname==='/api/world/trace')return this.#ok({traces:queryTraces({botId:stringParam(url,'botId'),domainId:stringParam(url,'domainId'),limit:intParam(url,'limit')})});
    if(method==='GET'&&pathname==='/api/tasks/future'){
      const status=stringParam(url,'status');if(status&&!['pending','claimed','completed','failed','expired','uncertain'].includes(status))throw new HttpError(400,'invalid task status');
      const limit=intParam(url,'limit');if(limit!==undefined&&(limit<1||limit>500))throw new HttpError(400,'invalid limit');
      const globalRead=auth.principal.role==='admin'||auth.principal.role==='developer';
      return this.#ok({tasks:await this.#futureTasks.list({status:status as any,owner:globalRead?stringParam(url,'owner'):auth.principal.id,type:stringParam(url,'type'),limit})});
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
       if(!this.#opts.snapshots().some((snapshot)=>snapshot.id===payload.botId))throw new HttpError(404,'bot not found');
       const task=await this.#futureTasks.schedule({type,payload,owner,scheduledAt:typeof input.scheduledAt==='number'?input.scheduledAt:undefined,maxRetries:typeof input.maxRetries==='number'?input.maxRetries:undefined,timeoutMs:typeof input.timeoutMs==='number'?input.timeoutMs:undefined});
       return{status:201,body:{ok:true,task}};
     }
     const reconcileMatch=pathname.match(/^\/api\/tasks\/future\/([^/]+)\/reconcile$/);
     if(method==='POST'&&reconcileMatch){
       const task=await this.#futureTasks.get(decodeURIComponent(reconcileMatch[1]!));
       if(!task)throw new HttpError(404,'task not found');
       if(task.owner!==auth.principal.id&&!['admin','developer'].includes(auth.principal.role))throw new HttpError(404,'task not found');
       if(task.status!=='uncertain')throw new HttpError(409,'task is not uncertain');
       if(task.type!=='discord.deliver')throw new HttpError(409,'task type is not reconcilable');
       const key=task.payload.dedupeKey;
       if(typeof key!=='string')throw new HttpError(400,'invalid dedupeKey');
       const record=await new DiscordDeliveryOutbox(this.#opts.storage).get(key);
       const outcome=record?.status==='delivered'?'delivered':record?.status==='rejected'?'rejected':'unknown';
       const updated=await this.#futureTasks.reconcile(task.id,outcome,record?.error??'outbox record does not establish delivery');
       return this.#ok({task:updated,record});
     }
    if (method === 'POST' && pathname === '/api/world/schedule') return { status: 201, body: { ok: true, world: await this.#worldFor(stateBotId()).schedule({ ...input, trust: 'candidate' }) } };
    if (method === 'POST' && /^\/api\/world\/schedule\/[^/]+\/trust$/.test(pathname)) {
      const id = decodeURIComponent(pathname.split('/')[4] ?? '');
      const trust = String(input.trust ?? 'candidate');
      if (!['candidate', 'confirmed', 'rejected'].includes(trust)) throw new HttpError(400, 'invalid trust');
      return this.#ok({ world: await this.#worldFor(stateBotId()).confirmScheduled(id, trust as 'candidate'|'confirmed'|'rejected') });
    }
    if (method === 'POST' && pathname === '/api/world/tick') return this.#ok({ world: await this.#worldFor(stateBotId()).tick() });
    if (method === 'GET' && pathname === '/api/world/day-plan') {
      const world = await this.#worldFor(stateBotId()).get();
      const plan = await new RuleDayPlanner().plan({ date: new Date().toISOString().slice(0, 10), character: 'MohoBot', world });
      return this.#ok({ plan });
    }
    if (method === 'POST' && pathname === '/api/world/events') return { status: 201, body: { ok: true, world: await this.#worldFor(stateBotId()).event(String(input.type ?? 'social'), String(input.text ?? '').trim()) } };
    if (method === 'GET' && pathname === '/api/device') return this.#ok({ device: await this.#deviceFor(stateBotId()).get() });
    if (method === 'POST' && pathname === '/api/device/transition') {
      const {botId: _botId,...patch}=input;return this.#ok({ device: await this.#deviceFor(stateBotId()).transition(parseDevicePatch(patch)) });
    }
    if (method === 'GET' && pathname === '/api/affinity') return this.#ok({ affinity: await this.#affinity.list(url.searchParams.get('botId') ?? undefined) });
    if (method === 'POST' && pathname === '/api/affinity/adjust') {
      const parsed=parseAffinityAdjust(input);const row = await this.#affinity.adjust(parsed.botId,parsed.userId,parsed.delta,parsed.reason,parsed.note);
      return this.#ok({ affinity: row });
    }
    if(method==='GET'&&pathname==='/api/guild/inventory'){
      const planner=this.#guildPlanner();
      const botId=typeof url.searchParams.get('botId')==='string'?url.searchParams.get('botId')!:'';
      const guildId=url.searchParams.get('guildId');
      if(!guildId)throw new HttpError(400,'guildId required');
      const result=await planner.inventory(botId||this.#defaultBotId(),guildId);
      return this.#ok(result);
    }
    if(method==='POST'&&pathname==='/api/guild/plan'){
      const planner=this.#guildPlanner();
      const botId=typeof input.botId==='string'?input.botId:'';
      const guildId=typeof input.guildId==='string'?input.guildId:'';
      if(!guildId)throw new HttpError(400,'guildId required');
      const result=await planner.plan(botId||this.#defaultBotId(),guildId);
      return this.#ok(result);
    }
    if(method==='POST'&&pathname==='/api/guild/apply'){
      const planner=this.#guildPlanner();
      const botId=typeof input.botId==='string'?input.botId:'';
      const plan=input.plan;
      if(!plan||typeof plan!=='object'||Array.isArray(plan))throw new HttpError(400,'plan object required');
      const expectedDigest=typeof input.expectedDigest==='string'?input.expectedDigest:'';
      const idempotencyKey=typeof input.idempotencyKey==='string'?input.idempotencyKey:'';
      if(!expectedDigest)throw new HttpError(400,'expectedDigest required');
      if(!idempotencyKey)throw new HttpError(400,'idempotencyKey required');
      const result=await planner.apply(botId||this.#defaultBotId(),plan as any,expectedDigest,idempotencyKey);
      return this.#ok(result);
    }
    if(method==='GET'&&pathname==='/api/social/disclosure-audit'){
      const limit=intParam(url,'limit')??50;if(!Number.isSafeInteger(limit)||limit<1||limit>200)throw new HttpError(400,'invalid limit');
      const botId=stringParam(url,'botId');
      return this.#ok({entries:await listDisclosureAudits(this.#opts.storage,botId||undefined,limit)});
    }
    throw new HttpError(403, `handler missing for policy ${policy.action}`);
  }

  #issueConfirmation(auth: AuthenticatedAdmin, input: Record<string, unknown>): ApiResult {
    const method = String(input.method ?? '').toUpperCase();
    const rawPath = String(input.path ?? '');
    const pathname = rawPath.startsWith('/api/') ? rawPath : `/api${rawPath.startsWith('/') ? rawPath : `/${rawPath}`}`;
    const payload = input.body === undefined ? {} : input.body;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new HttpError(400, 'confirmation body must be an object');
    const target = routePolicy(method, pathname);
    if (!target || !target.confirmation || !target.permission) throw new HttpError(403, 'target is not confirmable');
    if (!can(auth.principal, target.permission)) throw new HttpError(403, 'forbidden');
    const challenge = this.#confirmations.issue({ principal: auth.principal, permission: target.permission, action: `${target.action}:${method}:${pathname}`, payload });
    return { status: 201, body: { ok: true, confirmation: challenge, target: { method, path: pathname, action: target.action } } };
  }

  async #auditSafely(auth: AuthenticatedAdmin | undefined, method: string, pathname: string, status: number, outcome: 'allowed'|'denied', detail: string): Promise<void> {
    try { await this.#audit(auth, method, pathname, status, outcome, detail); }
    catch (error) { this.#opts.logger.error({ method, path: pathname, err: error instanceof Error ? error.message : String(error) }, 'admin audit persistence failed'); }
  }

  async #audit(auth: AuthenticatedAdmin | undefined, method: string, pathname: string, status: number, outcome: 'allowed'|'denied', detail: string): Promise<void> {
    const now = Date.now();
    const record: AuditRecord = {
      id: crypto.randomUUID(), at: new Date(now).toISOString(), actor: auth?.user.normalizedUsername ?? 'anonymous',
      action: routePolicy(method, pathname)?.action ?? `${method} ${pathname}`, outcome, detail, method, path: pathname, status,
    };
    await this.#opts.storage.save(`${AUDIT_PREFIX}${String(now).padStart(16, '0')}:${record.id}`, record);
  }

  #providers():ProviderControl{if(!this.#opts.providers)throw new HttpError(409,'provider control unavailable');return this.#opts.providers;}

  #control(): BotControlFacade {
    if (!this.#opts.botControl) throw new HttpError(409, 'bot control unavailable');
    return this.#opts.botControl;
  }

  #guildPlanner():GuildPlanner{if(!this.#opts.guildPlanner)throw new HttpError(409,'guild planner unavailable');return this.#opts.guildPlanner;}
  #defaultBotId():string{const ids=this.#opts.snapshots().map(s=>s.id);if(ids.length===1)return ids[0]!;if(ids.length===0)throw new HttpError(409,'no bots available');throw new HttpError(400,'botId required when multiple bots are configured');}

  #mapError(error: unknown): HttpError {
    if (error instanceof HttpError) return error;
    if (error instanceof BotControlError) {
      if (error.code === 'bot_not_found' || error.code === 'plugin_not_found') return new HttpError(404, error.code);
      if (error.code === 'busy') return new HttpError(409, error.code);
      return new HttpError(409, error.code);
    }
    if(error instanceof ProviderControlError)return new HttpError(404,error.code);
    if(error instanceof DebugChatError){if(error.code==='bot_not_found')return new HttpError(404,error.code);if(error.code==='provider_unavailable')return new HttpError(409,error.code);if(error.code==='rate_limited')return new HttpError(429,error.code);if(error.code==='input_invalid')return new HttpError(400,error.code);return new HttpError(502,error.code);}
    if(error instanceof TaskControlError)return new HttpError(error.code==='not_found'?404:409,error.code);
    if(error instanceof OpsControlError){if(error.code==='not_found')return new HttpError(404,error.message);if(error.code==='invalid_state')return new HttpError(409,error.message);return new HttpError(400,error.message);}
    if (error instanceof AdminAuthError) {
      if (error.code === 'username_taken' || error.code === 'last_admin' || error.code === 'locked') return new HttpError(409, error.code);
      if (error.code === 'not_found') return new HttpError(404, error.code);
      if (error.code === 'disabled') return new HttpError(403, error.code);
      return new HttpError(400, error.code);
    }
    if(error instanceof CrossChatError){if(error.code==='character_not_found')return new HttpError(404,error.code);return new HttpError(400,error.code);}
    if(error instanceof Error&&error.message==='provider_unavailable')return new HttpError(409,error.message);
    if(error instanceof McpError){if(error.code==='denied')return new HttpError(403,error.message);if(error.code==='tool')return new HttpError(404,error.message);return new HttpError(502,error.message);}
    if(error instanceof Error&&error.message==='character revision conflict')return new HttpError(409,error.message);
    if(error instanceof Error&&error.message==='character not found')return new HttpError(404,error.message);
    return new HttpError(400, error instanceof Error ? error.message : 'bad request');
  }

  #assignableRole(principal: AdminPrincipal, value: unknown): AdminRole {
    const role = this.#role(value);
    const ranks: Record<AdminRole, number> = { viewer: 0, operator: 1, admin: 2, developer: 3 };
    if (ranks[role] > ranks[principal.role]) throw new HttpError(403, 'cannot assign higher role');
    return role;
  }

  #role(value: unknown): AdminRole {
    const role = String(value ?? '');
    if (!ROLES.has(role as AdminRole)) throw new HttpError(400, 'invalid role');
    return role as AdminRole;
  }

  #ok(value: Record<string, unknown>): ApiResult { return { status: 200, body: { ok: true, ...value } }; }

  async #static(res: ServerResponse, pathname: string): Promise<void> {
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const root = path.resolve(this.#opts.rootDir, 'webui');
    const file = path.resolve(root, relative);
    if (!file.startsWith(`${root}${path.sep}`) && file !== path.join(root, 'index.html')) return json(res, 403, { error: 'forbidden' });
    try {
      const data = await fs.readFile(file);
      const ext = path.extname(file);
      const type = ext === '.html' ? 'text/html' : ext === '.css' ? 'text/css' : ext === '.js' ? 'text/javascript' : 'application/octet-stream';
      res.writeHead(200, { ...securityHeaders(), 'cache-control': 'no-cache', 'content-type': `${type}; charset=utf-8`, 'content-length': data.length });
      res.end(data);
    } catch { json(res, 404, { error: 'not found' }); }
  }
}
