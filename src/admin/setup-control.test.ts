import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNullLogger } from '../core/logger.js';
import { MemoryStorage } from '../storage/memory.js';
import { AdminAuthService } from './auth-service.js';
import { AdminServer } from './server.js';
import { SetupControl } from './setup-control.js';

describe('SetupControl', () => {
  let root: string;
  let storage: MemoryStorage;
  let auth: AdminAuthService;
  let masterToken: string;
  let setup: SetupControl;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mohobot-setup-'));
    storage = new MemoryStorage({ logger: createNullLogger() });
    await storage.init();
    auth = new AdminAuthService({ storage });
    masterToken = '';
    setup = new SetupControl({ rootDir: root, auth, token: () => masterToken });
  });

  afterEach(async () => {
    await storage.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reports uninitialized before setup', async () => {
    const status = await setup.status();
    expect(status.initialized).toBe(false);
    expect(status.users).toBe(0);
  });

  it('initializes the deployment: master token persisted, developer account created, session returned', async () => {
    const result = await setup.init({ username: 'miko', password: 'correct horse battery' });
    expect(result.masterToken).toMatch(/^moho_/);
    expect(result.token.length).toBeGreaterThan(10);
    expect(result.auth.principal.role).toBe('developer');
    const envLocal = await fs.readFile(path.join(root, 'data', '.env.local'), 'utf8');
    expect(envLocal).toContain(`MOHO_ADMIN_TOKEN=${result.masterToken}`);
    await fs.access(path.join(root, 'data', 'mohobot.db'));
    const authed = await auth.authenticate(result.token);
    expect(authed?.user.username).toBe('miko');
    const status = await setup.status();
    expect(status.users).toBe(1);
  });

  it('rejects a second initialization once a master token exists', async () => {
    const result = await setup.init({ username: 'miko', password: 'correct horse battery' });
    masterToken = result.masterToken; // simulate the server's in-process token swap
    await expect(setup.init({ username: 'mallory', password: 'another password 1' })).rejects.toMatchObject({ code: 'already_initialized' });
  });

  it('validates username and password before touching the filesystem', async () => {
    await expect(setup.init({ username: '', password: 'correct horse battery' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(setup.init({ username: 'miko', password: 'short' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(fs.access(path.join(root, 'data', '.env.local'))).rejects.toThrow();
  });
});

describe('AdminServer setup routes', () => {
  let root: string;
  let storage: MemoryStorage;
  let server: AdminServer;
  let base: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mohobot-setup-http-'));
    await fs.mkdir(path.join(root, 'webui'), { recursive: true });
    await fs.writeFile(path.join(root, 'webui', 'index.html'), '<h1>Moho</h1>');
    storage = new MemoryStorage({ logger: createNullLogger() });
    await storage.init();
    server = new AdminServer({
      rootDir: root, host: '127.0.0.1', port: 0, token: '', logger: createNullLogger(), storage,
      snapshots: () => [],
    });
    await server.start();
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server.stop();
    await storage.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function call(method: string, pathname: string, body?: Record<string, unknown>, token?: string): Promise<{ status: number; data: Record<string, any> }> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(`${base}${pathname}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json() as Record<string, any> };
  }

  it('exposes unauthenticated setup status and blocks the API before init', async () => {
    const status = await call('GET', '/api/setup/status');
    expect(status.status).toBe(200);
    expect(status.data.initialized).toBe(false);
    const denied = await call('GET', '/api/status');
    expect(denied.status).toBe(401);
  });

  it('completes first-run setup over HTTP: session works, master token hot-swaps, init closes', async () => {
    const bad = await call('POST', '/api/setup/init', { username: 'miko', password: 'short' });
    expect(bad.status).toBe(400);

    const init = await call('POST', '/api/setup/init', { username: 'miko', password: 'correct horse battery' });
    expect(init.status).toBe(201);
    expect(init.data.ok).toBe(true);
    expect(init.data.masterToken).toMatch(/^moho_/);
    expect(init.data.auth.principal.role).toBe('developer');

    const me = await call('GET', '/api/auth/me', undefined, init.data.token);
    expect(me.status).toBe(200);
    expect(me.data.auth.user.username).toBe('miko');

    const bootstrap = await fetch(`${base}/api/auth/bootstrap/session`, { method: 'POST', headers: { 'x-admin-token': init.data.masterToken } });
    expect(bootstrap.status).toBe(201);

    const after = await call('GET', '/api/setup/status');
    expect(after.data.initialized).toBe(true);
    const again = await call('POST', '/api/setup/init', { username: 'mallory', password: 'another password 1' });
    expect(again.status).toBe(409);
  });
});
