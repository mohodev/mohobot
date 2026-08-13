import fs from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { CharacterCatalog } from '../characters/catalog.js';
import type { Logger } from '../core/logger.js';
import type { BotSnapshot } from '../bot/runtime.js';
import { WorldStore } from './world.js';
import { AffinityStore } from './affinity.js';
import { RuleDayPlanner } from './day-planner.js';
import { ADMIN_ACTIONS, AuditTrail, healthSnapshot } from './actions.js';
import { DeviceStore } from './device.js';
import { ModelCatalogStore, recommend } from '../ai/model-catalog.js';

export interface AdminServerOptions {
  rootDir: string;
  host: string;
  port: number;
  token: string;
  logger: Logger;
  snapshots: () => BotSnapshot[];
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data), 'cache-control': 'no-store' });
  res.end(data);
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 1_000_000) throw new Error('request body too large');
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON object required');
  return value as Record<string, unknown>;
}

export class AdminServer {
  readonly #opts: AdminServerOptions;
  readonly #characters: CharacterCatalog;
  readonly #world: WorldStore;
  readonly #affinity: AffinityStore;
  readonly #device: DeviceStore;
  readonly #catalog: ModelCatalogStore;
  readonly #audit = new AuditTrail();
  #server?: http.Server;

  constructor(opts: AdminServerOptions) {
    this.#opts = opts;
    this.#characters = new CharacterCatalog(opts.rootDir);
    this.#world = new WorldStore(opts.rootDir);
    this.#affinity = new AffinityStore(opts.rootDir);
    this.#device = new DeviceStore(opts.rootDir);
    this.#catalog = new ModelCatalogStore(opts.rootDir);
  }

  async start(): Promise<void> {
    if (this.#server) return;
    this.#server = http.createServer((req, res) => void this.#handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.#server!.once('error', reject);
      this.#server!.listen(this.#opts.port, this.#opts.host, resolve);
    });
    this.#opts.logger.info({ host: this.#opts.host, port: this.#opts.port }, 'admin WebUI ready');
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname.startsWith('/api/')) {
        if (!this.#authorized(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
        return await this.#api(req, res, url);
      }
      await this.#static(res, url.pathname);
    } catch (error) {
      this.#opts.logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'admin request failed');
      json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  #authorized(req: IncomingMessage): boolean {
    if (!this.#opts.token) return false;
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    return bearer === this.#opts.token || req.headers['x-admin-token'] === this.#opts.token;
  }

  async #api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method === 'GET' && url.pathname === '/api/models') {
      const catalog = await this.#catalog.get();
      const task = url.searchParams.get('task');
      return json(res, 200, { ok: true, catalog, recommendations: task ? recommend(catalog, task) : undefined });
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      return json(res, 200, { ok: true, now: new Date().toISOString(), bots: this.#opts.snapshots() });
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/actions') {
      return json(res, 200, { ok: true, actions: ADMIN_ACTIONS, audit: this.#audit.list() });
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/health') {
      const actor = String(req.headers['x-admin-actor'] ?? 'local-admin');
      this.#audit.record({ actor, action: 'runtime.health', outcome: 'allowed', detail: 'read-only health snapshot' });
      return json(res, 200, { ok: true, health: healthSnapshot(this.#opts.snapshots()) });
    }
    if (req.method === 'GET' && url.pathname === '/api/characters') {
      const rows = await this.#characters.list();
      return json(res, 200, { ok: true, characters: rows.map(({ prompt, ...item }) => ({ ...item, promptLength: prompt.length })) });
    }
    if (req.method === 'POST' && url.pathname === '/api/characters') {
      const input = await body(req);
      const saved = await this.#characters.save({
        id: typeof input.id === 'string' ? input.id : undefined,
        name: String(input.name ?? '').trim(),
        prompt: String(input.prompt ?? ''),
        source: typeof input.source === 'string' ? input.source : undefined,
      });
      return json(res, 201, { ok: true, character: { ...saved, promptLength: saved.prompt.length } });
    }
    if (req.method === 'GET' && url.pathname === '/api/world') return json(res, 200, { ok: true, world: await this.#world.get() });
    if (req.method === 'GET' && url.pathname === '/api/device') return json(res, 200, { ok: true, device: await this.#device.get() });
    if (req.method === 'POST' && url.pathname === '/api/device/transition') {
      const input = await body(req);
      const allowed = ['battery', 'charging', 'network', 'screen', 'doNotDisturb', 'activity', 'notificationCount'];
      const patch = Object.fromEntries(allowed.filter((key) => key in input).map((key) => [key, input[key]]));
      return json(res, 200, { ok: true, device: await this.#device.transition(patch) });
    }
    if (req.method === 'GET' && url.pathname === '/api/affinity') {
      return json(res, 200, { ok: true, affinity: await this.#affinity.list(url.searchParams.get('botId') ?? undefined) });
    }
    if (req.method === 'POST' && url.pathname === '/api/affinity/adjust') {
      const input = await body(req);
      const row = await this.#affinity.adjust(String(input.botId ?? 'main'), String(input.userId ?? ''), Number(input.delta ?? 0), String(input.reason ?? 'manual') as 'manual', typeof input.note === 'string' ? input.note : undefined);
      return json(res, 200, { ok: true, affinity: row });
    }
    if (req.method === 'POST' && url.pathname === '/api/world/schedule') {
      const input = await body(req);
      return json(res, 201, { ok: true, world: await this.#world.schedule(input) });
    }
    if (req.method === 'POST' && /^\/api\/world\/schedule\/[^/]+\/trust$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split('/')[4] ?? '');
      const input = await body(req);
      const trust = String(input.trust ?? 'candidate');
      if (!['candidate','confirmed','rejected'].includes(trust)) throw new Error('invalid trust');
      return json(res, 200, { ok: true, world: await this.#world.confirmScheduled(id, trust as 'candidate'|'confirmed'|'rejected') });
    }
    if (req.method === 'POST' && url.pathname === '/api/world/tick') return json(res, 200, { ok: true, world: await this.#world.tick() });
    if (req.method === 'GET' && url.pathname === '/api/world/day-plan') {
      const world = await this.#world.get();
      const planner = new RuleDayPlanner();
      const plan = await planner.plan({ date: new Date().toISOString().slice(0, 10), character: 'MohoBot', world });
      return json(res, 200, { ok: true, plan });
    }
    if (req.method === 'POST' && url.pathname === '/api/world/events') {
      const input = await body(req);
      const state = await this.#world.event(String(input.type ?? 'social'), String(input.text ?? '').trim());
      return json(res, 201, { ok: true, world: state });
    }
    json(res, 404, { ok: false, error: 'not found' });
  }

  async #static(res: ServerResponse, pathname: string): Promise<void> {
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const root = path.join(this.#opts.rootDir, 'webui');
    const file = path.resolve(root, relative);
    if (!file.startsWith(path.resolve(root) + path.sep) && file !== path.join(path.resolve(root), 'index.html')) return json(res, 403, { error: 'forbidden' });
    try {
      const data = await fs.readFile(file);
      const ext = path.extname(file);
      const type = ext === '.html' ? 'text/html' : ext === '.css' ? 'text/css' : ext === '.js' ? 'text/javascript' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'content-length': data.length });
      res.end(data);
    } catch {
      json(res, 404, { error: 'not found' });
    }
  }
}
