import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import type { BotSnapshot } from '../bot/runtime.js';
import { CharacterCatalog } from '../characters/catalog.js';
import type { Logger } from '../core/logger.js';
import { runtimeMetrics } from '../core/runtime-metrics.js';
import type { Storage } from '../storage/types.js';
import { ModelCatalogStore, recommend } from '../ai/model-catalog.js';
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
import { WorldStore } from './world.js';

export interface ConfigPublicationAdapter {
  get(): Promise<unknown>;
  publish(input: Record<string, unknown>, principal: AdminPrincipal): Promise<unknown>;
  acknowledge?(input: any,principal:AdminPrincipal):Promise<unknown>;
  rollback?(input:any,principal:AdminPrincipal):Promise<unknown>;
}

export interface AdminServerOptions {
  rootDir: string;
  host: string;
  port: number;
  token: string;
  logger: Logger;
  storage: Storage;
  snapshots: () => BotSnapshot[];
  remoteHealth?: () => Promise<unknown>;
  configPublication?: ConfigPublicationAdapter;
  modelHealth?: () => Promise<unknown>;
  botControl?: BotControlFacade;
  ops?: OpsControlFacade;
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
  #server?: http.Server;

  constructor(opts: AdminServerOptions) {
    this.#opts = opts;
    this.#auth = new AdminAuthService({ storage: opts.storage });
    this.#characters = new CharacterCatalog(opts.rootDir);
    this.#world = new WorldStore(opts.rootDir);
    this.#affinity = new AffinityStore(opts.rootDir);
    this.#device = new DeviceStore(opts.rootDir);
    this.#catalog = new ModelCatalogStore(opts.rootDir);
  }

  get port(): number | undefined {
    const address = this.#server?.address();
    return address && typeof address === 'object' ? address.port : undefined;
  }

  async start(): Promise<void> {
    if (this.#server) return;
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
    if (method === 'GET' && pathname === '/api/auth/me') return this.#ok({ auth, permissions: permissionsFor(auth.principal.role) });
    if (method === 'POST' && pathname === '/api/auth/logout') { await this.#auth.revokeSession(token); return this.#ok({ loggedOut: true }); }
    if (method === 'GET' && pathname === '/api/auth/sessions') return this.#ok({ sessions: await this.#auth.listSessions() });
    const sessionMatch = pathname.match(/^\/api\/auth\/sessions\/([^/]+)$/);
    if (method === 'DELETE' && sessionMatch) {
      const revoked = await this.#auth.revokeSessionById(decodeURIComponent(sessionMatch[1]!));
      if (!revoked) throw new HttpError(404, 'session not found');
      return this.#ok({ revoked: true });
    }
    if (method === 'POST' && pathname === '/api/confirmations') return this.#issueConfirmation(auth, input);
    if (method === 'GET' && pathname === '/api/metrics') return this.#ok({ metrics: runtimeMetrics.snapshot() });
    if (method === 'GET' && pathname === '/api/status') return this.#ok({ now: new Date().toISOString(), bots: this.#opts.snapshots() });
    if (method === 'GET' && pathname === '/api/models') {
      const catalog = await this.#catalog.get();
      const task = url.searchParams.get('task');
      return this.#ok({ catalog, recommendations: task ? recommend(catalog, task) : undefined });
    }
    if (method === 'GET' && pathname === '/api/models/health') return this.#ok({ health: await this.#opts.modelHealth?.() ?? this.#opts.botControl?.modelHealth() ?? { configured: false } });
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
    const opsSession=pathname.match(/^\/api\/ops\/sessions\/(.+)$/);if(method==='DELETE'&&opsSession){await requireOps(this.#opts.ops).deleteSession(decodeURIComponent(opsSession[1]!));return this.#ok({deleted:true});}
    if(method==='GET'&&pathname==='/api/ops/outbox'){const outbox=await requireOps(this.#opts.ops).listOutbox({limit:intParam(url,'limit'),offset:intParam(url,'offset'),status:stringParam(url,'status') as any});return this.#ok({outbox});}
    const outboxRetry=pathname.match(/^\/api\/ops\/outbox\/([^/]+)\/retry$/);if(method==='POST'&&outboxRetry){const event=await requireOps(this.#opts.ops).retryOutbox(decodeURIComponent(outboxRetry[1]!));return this.#ok({event});}
    if(method==='GET'&&pathname==='/api/tasks')return this.#ok({tasks:requireOps(this.#opts.ops).listTasks({limit:intParam(url,'limit'),offset:intParam(url,'offset')})});
    if (method === 'GET' && pathname === '/api/admin/health') return this.#ok({ health: healthSnapshot(this.#opts.snapshots()) });
    if (method === 'GET' && pathname === '/api/remote/health') return this.#ok({ health: await this.#opts.remoteHealth?.() ?? { configured: false } });
    if (method === 'GET' && pathname === '/api/config/publication') return this.#ok({ publication: await this.#opts.configPublication?.get() ?? null });
    if (method === 'POST' && pathname === '/api/config/publish') {
      if (!this.#opts.configPublication) throw new HttpError(409, 'config publication unavailable');
      return this.#ok({ publication: await this.#opts.configPublication.publish(input, auth.principal) });
    }
    if(method==='POST'&&pathname==='/api/config/ack'){if(!this.#opts.configPublication?.acknowledge)throw new HttpError(409,'config acknowledgement unavailable');return this.#ok({publication:await this.#opts.configPublication.acknowledge(input,auth.principal)});}
    if(method==='POST'&&pathname==='/api/config/rollback'){if(!this.#opts.configPublication?.rollback)throw new HttpError(409,'config rollback unavailable');return this.#ok({publication:await this.#opts.configPublication.rollback(input,auth.principal)});}
    if (method === 'GET' && pathname === '/api/admin/users') return this.#ok({ users: await this.#auth.listUsers() });
    if (method === 'POST' && pathname === '/api/admin/users') {
      const role = this.#role(input.role);
      const user = await this.#auth.createUser({ username: String(input.username ?? ''), password: String(input.password ?? ''), role, enabled: input.enabled === undefined ? true : Boolean(input.enabled) });
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
        patch.role = this.#role(input.role);
      }
      if (input.enabled !== undefined) {
        if (!can(auth.principal, 'users.disable')) throw new HttpError(403, 'forbidden');
        patch.enabled = Boolean(input.enabled);
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
    if (method === 'POST' && pathname === '/api/characters') {
      const saved = await this.#characters.save({ id: typeof input.id === 'string' ? input.id : undefined, name: String(input.name ?? '').trim(), prompt: String(input.prompt ?? ''), source: typeof input.source === 'string' ? input.source : undefined });
      return { status: 201, body: { ok: true, character: { ...saved, promptLength: saved.prompt.length } } };
    }
    if (method === 'GET' && pathname === '/api/world') return this.#ok({ world: await this.#world.get() });
    if (method === 'POST' && pathname === '/api/world/schedule') return { status: 201, body: { ok: true, world: await this.#world.schedule({ ...input, trust: 'candidate' }) } };
    if (method === 'POST' && /^\/api\/world\/schedule\/[^/]+\/trust$/.test(pathname)) {
      const id = decodeURIComponent(pathname.split('/')[4] ?? '');
      const trust = String(input.trust ?? 'candidate');
      if (!['candidate', 'confirmed', 'rejected'].includes(trust)) throw new HttpError(400, 'invalid trust');
      return this.#ok({ world: await this.#world.confirmScheduled(id, trust as 'candidate'|'confirmed'|'rejected') });
    }
    if (method === 'POST' && pathname === '/api/world/tick') return this.#ok({ world: await this.#world.tick() });
    if (method === 'GET' && pathname === '/api/world/day-plan') {
      const world = await this.#world.get();
      const plan = await new RuleDayPlanner().plan({ date: new Date().toISOString().slice(0, 10), character: 'MohoBot', world });
      return this.#ok({ plan });
    }
    if (method === 'POST' && pathname === '/api/world/events') return { status: 201, body: { ok: true, world: await this.#world.event(String(input.type ?? 'social'), String(input.text ?? '').trim()) } };
    if (method === 'GET' && pathname === '/api/device') return this.#ok({ device: await this.#device.get() });
    if (method === 'POST' && pathname === '/api/device/transition') {
      const allowed = ['battery', 'charging', 'network', 'screen', 'doNotDisturb', 'activity', 'notificationCount'];
      const patch = Object.fromEntries(allowed.filter((key) => key in input).map((key) => [key, input[key]]));
      return this.#ok({ device: await this.#device.transition(patch) });
    }
    if (method === 'GET' && pathname === '/api/affinity') return this.#ok({ affinity: await this.#affinity.list(url.searchParams.get('botId') ?? undefined) });
    if (method === 'POST' && pathname === '/api/affinity/adjust') {
      const row = await this.#affinity.adjust(String(input.botId ?? 'main'), String(input.userId ?? ''), Number(input.delta ?? 0), 'manual', typeof input.note === 'string' ? input.note : undefined);
      return this.#ok({ affinity: row });
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

  #control(): BotControlFacade {
    if (!this.#opts.botControl) throw new HttpError(409, 'bot control unavailable');
    return this.#opts.botControl;
  }

  #mapError(error: unknown): HttpError {
    if (error instanceof HttpError) return error;
    if (error instanceof BotControlError) {
      if (error.code === 'bot_not_found' || error.code === 'plugin_not_found') return new HttpError(404, error.code);
      if (error.code === 'busy') return new HttpError(409, error.code);
      return new HttpError(409, error.code);
    }
    if(error instanceof OpsControlError){if(error.code==='not_found')return new HttpError(404,error.message);if(error.code==='invalid_state')return new HttpError(409,error.message);return new HttpError(400,error.message);}
    if (error instanceof AdminAuthError) {
      if (error.code === 'username_taken' || error.code === 'last_admin' || error.code === 'locked') return new HttpError(409, error.code);
      if (error.code === 'not_found') return new HttpError(404, error.code);
      if (error.code === 'disabled') return new HttpError(403, error.code);
      return new HttpError(400, error.code);
    }
    return new HttpError(400, error instanceof Error ? error.message : 'bad request');
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
