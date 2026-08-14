import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotSnapshot } from '../bot/runtime.js';
import { createNullLogger } from '../core/logger.js';
import { MemoryStorage } from '../storage/memory.js';
import { AdminAuthService } from './auth-service.js';
import { BotControlFacade } from './bot-control.js';
import { AdminServer } from './server.js';

interface Reply { status: number; data: Record<string, any>; text: string }

function snapshot(id = 'main'): BotSnapshot {
  return {
    id, name: id === 'main' ? 'Main' : 'Other', running: true, adapter: 'discord',
    model: 'secret-model-id', provider: 'secret-provider-name',
    gateway: { connected: true, ping: 10, username: `${id}-bot`, guilds: 2, reconnects: 1, lastError: 'https://secret.invalid?token=gateway-secret' },
    sessions: 9, plugins: [{ id: 'demo', state: 'loaded', errors: 0 }],
    pipeline: { handled: 10, replied: 9, skipped: 1, aiFailures: 0, rateLimited: 0 },
    modelHealth: { generatedAt: 1, profiles: [], models: { reply: { availability: 'available', checkedAt: 1 } } },
  };
}

describe('Bot/Gateway/Plugin admin control API', () => {
  let root = '';
  let storage: MemoryStorage;
  let server: AdminServer;
  let base = '';
  let snapshots: BotSnapshot[];
  let releaseRestart: (() => void) | undefined;
  let restartEntered: (() => void) | undefined;
  let restartMode: 'success'|'fail'|'wait';
  const restart = vi.fn(async (botId: string) => {
    if (!snapshots.some((bot) => bot.id === botId)) return false;
    if (restartMode === 'fail') return false;
    if (restartMode === 'wait') {
      restartEntered?.();
      await new Promise<void>((resolve) => { releaseRestart = resolve; });
    }
    return true;
  });
  const reload = vi.fn(async (botId: string, pluginId: string) => snapshots.some((bot) => bot.id === botId && bot.plugins.some((plugin) => plugin.id === pluginId)));

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'moho-bot-control-api-'));
    await fs.mkdir(path.join(root, 'webui'), { recursive: true });
    await fs.writeFile(path.join(root, 'webui', 'index.html'), '<h1>Moho</h1>');
    storage = new MemoryStorage({ logger: createNullLogger() }); await storage.init();
    snapshots = [snapshot(), snapshot('other')]; restartMode = 'success'; restart.mockClear(); reload.mockClear();
    const control = new BotControlFacade({ snapshots: () => snapshots, restart, reloadPlugin: reload });
    server = new AdminServer({ rootDir: root, host: '127.0.0.1', port: 0, token: 'master-control-token', logger: createNullLogger(), storage, snapshots: () => snapshots, botControl: control, modelHealth: async () => control.modelHealth() });
    await server.start(); base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => { releaseRestart?.(); await server.stop(); await storage.close(); await fs.rm(root, { recursive: true, force: true }); });

  async function request(method: string, pathname: string, options: { token?: string; confirmation?: string; body?: Record<string, unknown> } = {}): Promise<Reply> {
    const headers: Record<string, string> = {};
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (options.confirmation) headers['x-admin-confirmation'] = options.confirmation;
    if (options.body) headers['content-type'] = 'application/json';
    const response = await fetch(`${base}${pathname}`, { method, headers, body: options.body ? JSON.stringify(options.body) : undefined });
    const text = await response.text();
    return { status: response.status, data: JSON.parse(text) as Record<string, any>, text };
  }

  async function bootstrap(): Promise<string> {
    const response = await fetch(`${base}/api/auth/bootstrap/session`, { method: 'POST', headers: { 'x-admin-token': 'master-control-token' } });
    return (await response.json() as Record<string, any>).token as string;
  }

  async function viewer(): Promise<string> {
    const auth = new AdminAuthService({ storage });
    await auth.createUser({ username: 'gateway-viewer', password: 'long viewer password', role: 'viewer' });
    return (await auth.login('gateway-viewer', 'long viewer password')).token;
  }

  async function confirmation(token: string, pathname: string, body: Record<string, unknown> = {}): Promise<string> {
    const response = await request('POST', '/api/confirmations', { token, body: { method: 'POST', path: pathname, body } });
    expect(response.status).toBe(201);
    return response.data.confirmation.nonce as string;
  }

  it('enforces authentication and read/write RBAC', async () => {
    expect((await request('GET', '/api/bots')).status).toBe(401);
    const token = await viewer();
    expect((await request('GET', '/api/bots', { token })).status).toBe(200);
    expect((await request('GET', '/api/bots/main/gateway', { token })).status).toBe(200);
    expect((await request('GET', '/api/bots/main/plugins', { token })).status).toBe(200);
    expect((await request('POST', '/api/bots/main/restart', { token, body: {} })).status).toBe(403);
    expect((await request('POST', '/api/bots/main/plugins/demo/reload', { token, body: {} })).status).toBe(403);
  });

  it('returns allowlisted details and never leaks runtime secrets', async () => {
    const token = await bootstrap();
    const responses = await Promise.all([
      request('GET', '/api/bots', { token }), request('GET', '/api/bots/main', { token }),
      request('GET', '/api/bots/main/gateway', { token }), request('GET', '/api/bots/main/plugins', { token }),
      request('GET', '/api/models/health', { token }),
    ]);
    expect(responses.every(({ status }) => status === 200)).toBe(true);
    const all = responses.map(({ text }) => text).join('\n');
    expect(all).not.toMatch(/secret-model|secret-provider|secret\.invalid|gateway-secret|lastError|sessions|pipeline/);
    expect(responses[4]!.data.health.main.models.reply.availability).toBe('available');
  });

  it('returns 404 for missing bots and plugins and requires bound confirmations', async () => {
    const token = await bootstrap();
    expect((await request('GET', '/api/bots/missing', { token })).status).toBe(404);
    expect((await request('GET', '/api/bots/missing/gateway', { token })).status).toBe(404);
    expect((await request('POST', '/api/bots/main/restart', { token, body: {} })).status).toBe(409);
    const wrong = await confirmation(token, '/api/bots/other/restart');
    expect((await request('POST', '/api/bots/main/restart', { token, confirmation: wrong, body: {} })).status).toBe(409);
    const missing = await confirmation(token, '/api/bots/main/plugins/missing/reload');
    expect((await request('POST', '/api/bots/main/plugins/missing/reload', { token, confirmation: missing, body: {} })).status).toBe(404);
  });

  it('returns 200 for restart/reload and 409 for a concurrent write on the same bot', async () => {
    const token = await bootstrap();
    const reloadNonce = await confirmation(token, '/api/bots/main/plugins/demo/reload');
    expect((await request('POST', '/api/bots/main/plugins/demo/reload', { token, confirmation: reloadNonce, body: {} })).status).toBe(200);
    restartMode = 'wait';
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; }); restartEntered = entered;
    const firstNonce = await confirmation(token, '/api/bots/main/restart');
    const secondNonce = await confirmation(token, '/api/bots/main/restart');
    const first = request('POST', '/api/bots/main/restart', { token, confirmation: firstNonce, body: {} });
    await started;
    expect((await request('POST', '/api/bots/main/restart', { token, confirmation: secondNonce, body: {} })).status).toBe(409);
    releaseRestart?.();
    expect((await first).status).toBe(200);
  });

  it('attributes failed management actions to the authenticated actor', async () => {
    const token = await bootstrap(); restartMode = 'fail';
    const nonce = await confirmation(token, '/api/bots/main/restart');
    expect((await request('POST', '/api/bots/main/restart', { token, confirmation: nonce, body: {} })).status).toBe(409);
    const rows = await storage.query<Record<string, unknown>>({ prefix: 'admin-audit:' });
    expect(rows.some(({ value }) => value.actor === 'bootstrap' && value.action === 'runtime.restart' && value.status === 409)).toBe(true);
    expect(rows.some(({ value }) => value.detail === 'restart_failed' && value.actor === 'anonymous')).toBe(false);
  });
});
