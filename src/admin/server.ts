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
import{SemanticMemoryGovernance}from'../memory/semantic-memory-governance.js';
import type{ExpressionStatus}from'../memory/expression-memory.js';
import{KnowledgeBaseStore}from'../knowledge/store.js';
import type { Storage } from '../storage/types.js';
import { chatLogQuery } from '../storage/chatlog.js';
import { ModelCatalogStore, recommend } from '../ai/model-catalog.js';
import { ModelOperationsDashboard } from '../ai/model-operations.js';
import { ADMIN_ACTIONS, healthSnapshot, type AuditEntry } from './actions.js';
import { AffinityStore } from './affinity.js';
import { AdminAuthError, AdminAuthService, type AuthenticatedAdmin } from './auth-service.js';
import { SetupControl, SetupError } from './setup-control.js';
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
import { listPersistentDomains, queryPersistentTraces } from './world-isolation.js';
import { DiscordDeliveryOutbox } from '../discord/outbox.js';
import { AdminApiRouter } from './api-router.js';
import type { ApiResult } from './api-types.js';
import { HttpError } from './api-errors.js';

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

interface AuditRecord extends AuditEntry { method: string; path: string; status: number }

const BOOTSTRAP_USERNAME = 'bootstrap';
const AUDIT_PREFIX = 'admin-audit:';
const ROLES = new Set<AdminRole>(['viewer', 'operator', 'admin', 'developer']);

function securityHeaders(): Record<string, string> {
  return {
    'cache-control': 'no-store',
    // img-src allows data: for inline SVG/data-URI images in the React bundle.
    'content-security-policy': "default-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'",
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
  readonly #semanticGov:SemanticMemoryGovernance;
  readonly #jargon:JargonMemory;
  readonly #knowledge:KnowledgeBaseStore;
  readonly #modelDashboard:ModelOperationsDashboard;
  readonly #futureTasks:FutureTaskStore;
  readonly #setup: SetupControl;
  readonly #apiRouter: AdminApiRouter;
  #server?: http.Server;
  /** Deployment master token; swapped in-place when setup initializes the deployment. */
  #token: string;

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
    this.#affinity = new AffinityStore(opts.rootDir, opts.storage);
    this.#device = new DeviceStore(opts.rootDir);
    this.#catalog = new ModelCatalogStore(opts.rootDir);
    this.#memories=new MemoryAdminService(opts.storage);
    this.#expressionGov=new ExpressionMemoryGovernance({storage:opts.storage,logger:opts.logger});
    this.#semanticGov=new SemanticMemoryGovernance(opts.storage,opts.logger);
    this.#jargon=new JargonMemory({storage:opts.storage,logger:opts.logger});
    this.#knowledge=new KnowledgeBaseStore(opts.storage);
    this.#modelDashboard=new ModelOperationsDashboard({snapshots:opts.snapshots,usage:{totals:(botId,days)=>opts.snapshots().find((snapshot)=>snapshot.id===botId)?.usage?.totals(botId,days)??Promise.resolve([])}});
    this.#futureTasks=new FutureTaskStore(opts.storage);
    this.#token = opts.token;
    this.#setup = new SetupControl({ rootDir: opts.rootDir, auth: this.#auth, token: () => this.#token });
    this.#apiRouter = new AdminApiRouter({
      opts: this.#opts,
      auth: this.#auth,
      characters: this.#characters,
      affinity: this.#affinity,
      device: this.#device,
      catalog: this.#catalog,
      memories: this.#memories,
      expressionGov: this.#expressionGov,
      semanticGov: this.#semanticGov,
      jargon: this.#jargon,
      knowledge: this.#knowledge,
      modelDashboard: this.#modelDashboard,
      futureTasks: this.#futureTasks,
      issueConfirmation: (auth, input) => this.#issueConfirmation(auth, input),
    });
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
      if (method === 'GET' && pathname === '/api/setup/status') return await this.#setupStatus(res);
      if (method === 'POST' && pathname === '/api/setup/init') return await this.#setupInit(res, input, method, pathname);

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

      const result = await this.#apiRouter.handle(req, url, input, authenticated, policy, token);
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
    if (!this.#token || !supplied || !timingSafeStringEqual(supplied, this.#token)) {
      await this.#audit(undefined, method, pathname, 401, 'denied', 'invalid master token');
      return json(res, 401, { ok: false, error: 'unauthorized' });
    }
    const initialPassword = crypto.createHash('sha256').update(`bootstrap:${this.#token}`).digest('base64url');
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

  async #setupStatus(res: ServerResponse): Promise<void> {
    const status = await this.#setup.status();
    json(res, 200, { ok: true, ...status });
  }

  async #setupInit(res: ServerResponse, input: Record<string, unknown>, method: string, pathname: string): Promise<void> {
    try {
      const result = await this.#setup.init(input);
      // Hot-swap the deployment master token so the bootstrap exchange keeps
      // working for this process without a restart; on disk it lives in
      // data/.env.local and is picked up fresh on the next boot.
      this.#token = result.masterToken;
      await this.#audit(result.auth, method, pathname, 201, 'allowed', 'deployment initialized through setup');
      json(res, 201, { ok: true, token: result.token, auth: result.auth, masterToken: result.masterToken });
    } catch (error) {
      if (error instanceof SetupError) {
        const status = error.code === 'already_initialized' ? 409 : error.code === 'invalid_input' ? 400 : 500;
        await this.#audit(undefined, method, pathname, status, 'denied', `setup init refused: ${error.code}`);
        json(res, status, { ok: false, error: error.message });
        return;
      }
      throw error;
    }
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
    // The React control center is the primary console, built into the webui
    // root. `/dashboard/` remains an alias so older bookmarks keep resolving.
    const relative = pathname === '/' || pathname === '/dashboard' || pathname === '/dashboard/'
      ? 'index.html'
      : pathname.replace(/^\/+/, '');
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
