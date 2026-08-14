import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNullLogger } from '../core/logger.js';
import { MemoryStorage } from '../storage/memory.js';
import { AdminServer } from './server.js';

interface Reply { status: number; headers: Headers; data: Record<string, any> }

describe('AdminServer production authorization chain', () => {
  let root: string;
  let storage: MemoryStorage;
  let server: AdminServer;
  let base: string;
  const master = 'master-token-for-integration-tests';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mohobot-admin-server-'));
    await fs.mkdir(path.join(root, 'webui'), { recursive: true });
    await fs.writeFile(path.join(root, 'webui', 'index.html'), '<h1>Moho</h1>');
    storage = new MemoryStorage({ logger: createNullLogger() });
    await storage.init();
    server = new AdminServer({
      rootDir: root, host: '127.0.0.1', port: 0, token: master, logger: createNullLogger(), storage, snapshots: () => [],
      remoteHealth: async () => ({ mysql: { ok: true } }), modelHealth: async () => ({ reply: { ok: true } }),
      configPublication: { get: async () => ({ version: 1 }), publish: async (input, principal) => ({ ...input, actor: principal.id }) },
    });
    await server.start();
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server.stop();
    await storage.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function request(method: string, pathname: string, options: { token?: string; master?: string; confirmation?: string; body?: Record<string, unknown>; actor?: string } = {}): Promise<Reply> {
    const headers: Record<string, string> = {};
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (options.master) headers['x-admin-token'] = options.master;
    if (options.confirmation) headers['x-admin-confirmation'] = options.confirmation;
    if (options.actor) headers['x-admin-actor'] = options.actor;
    if (options.body) headers['content-type'] = 'application/json';
    const response = await fetch(`${base}${pathname}`, { method, headers, body: options.body ? JSON.stringify(options.body) : undefined });
    return { status: response.status, headers: response.headers, data: await response.json() as Record<string, any> };
  }

  async function bootstrap(): Promise<string> {
    const result = await request('POST', '/api/auth/bootstrap/session', { master, actor: 'attacker-controlled' });
    expect(result.status).toBe(201);
    expect(result.data.auth.user.normalizedUsername).toBe('bootstrap');
    return result.data.token as string;
  }

  async function confirmation(token: string, method: string, pathname: string, body: Record<string, unknown>): Promise<string> {
    const result = await request('POST', '/api/confirmations', { token, body: { method, path: pathname, body } });
    expect(result.status).toBe(201);
    return result.data.confirmation.nonce as string;
  }

  it('uses master token only for fixed bootstrap exchange and fails closed', async () => {
    expect((await request('GET', '/api/status', { master })).status).toBe(401);
    const session = await bootstrap();
    const me = await request('GET', '/api/auth/me', { token: session });
    expect(me.status).toBe(200);
    expect(me.data.auth.user.username).toBe('bootstrap');
    expect((await request('GET', '/api/not-in-policy', { token: session })).status).toBe(403);
    expect(me.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(me.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('supports confirmed user lifecycle, password login, me and logout', async () => {
    const admin = await bootstrap();
    const createBody = { username: 'viewer-one', password: 'long viewer password', role: 'viewer', enabled: true };
    expect((await request('POST', '/api/admin/users', { token: admin, body: createBody })).status).toBe(409);
    const createNonce = await confirmation(admin, 'POST', '/api/admin/users', createBody);
    expect((await request('POST', '/api/admin/users', { token: admin, confirmation: createNonce, body: { ...createBody, role: 'operator' } })).status).toBe(409);
    const createNonce2 = await confirmation(admin, 'POST', '/api/admin/users', createBody);
    expect((await request('POST', '/api/admin/users', { token: admin, confirmation: createNonce2, body: createBody })).status).toBe(201);
    expect((await request('GET', '/api/admin/users', { token: admin })).data.users).toHaveLength(2);

    const login = await request('POST', '/api/auth/login', { body: { username: 'VIEWER-ONE', password: 'long viewer password' } });
    expect(login.status).toBe(201);
    const viewer = login.data.token as string;
    expect((await request('GET', '/api/status', { token: viewer })).status).toBe(200);
    expect((await request('GET', '/api/admin/users', { token: viewer })).status).toBe(403);
    expect((await request('POST', '/api/auth/logout', { token: viewer })).status).toBe(200);
    expect((await request('GET', '/api/auth/me', { token: viewer })).status).toBe(401);
  });

  it('binds confirmations to canonical body and path and forces schedules candidate', async () => {
    const admin = await bootstrap();
    const event = { id: 'event-1', kind: 'concert', title: 'Show', startsAt: '2030-01-01T10:00:00Z', endsAt: '2030-01-01T12:00:00Z', location: 'Hall', trust: 'confirmed' };
    const scheduled = await request('POST', '/api/world/schedule', { token: admin, body: event });
    expect(scheduled.status).toBe(201);
    expect(scheduled.data.world.schedule[0].trust).toBe('candidate');

    const trustBody = { trust: 'confirmed' };
    const nonce = await confirmation(admin, 'POST', '/api/world/schedule/event-1/trust', trustBody);
    expect((await request('POST', '/api/world/schedule/other/trust', { token: admin, confirmation: nonce, body: trustBody })).status).toBe(409);
    const nonce2 = await confirmation(admin, 'POST', '/api/world/schedule/event-1/trust', trustBody);
    const confirmed = await request('POST', '/api/world/schedule/event-1/trust', { token: admin, confirmation: nonce2, body: trustBody });
    expect(confirmed.status).toBe(200);
    expect(confirmed.data.world.schedule[0].trust).toBe('confirmed');
    expect((await request('POST', '/api/world/schedule/event-1/trust', { token: admin, confirmation: nonce2, body: trustBody })).status).toBe(409);
  });

  it('exposes injected health and protects config publication with confirmation', async () => {
    const admin = await bootstrap();
    expect((await request('GET', '/api/remote/health', { token: admin })).data.health.mysql.ok).toBe(true);
    expect((await request('GET', '/api/models/health', { token: admin })).data.health.reply.ok).toBe(true);
    expect((await request('GET', '/api/config/publication', { token: admin })).data.publication.version).toBe(1);
    const publishBody = { version: 2, digest: 'abc' };
    const nonce = await confirmation(admin, 'POST', '/api/config/publish', publishBody);
    const published = await request('POST', '/api/config/publish', { token: admin, confirmation: nonce, body: publishBody });
    expect(published.status).toBe(200);
    expect(published.data.publication).toMatchObject({ version: 2, digest: 'abc' });
  });

  it('rotates passwords with confirmation and exposes revocable persistent sessions', async () => {
    const admin = await bootstrap();
    const passwordBody = { password: 'replacement password 123' };
    const nonce = await confirmation(admin, 'POST', '/api/admin/users/bootstrap/password', passwordBody);
    expect((await request('POST', '/api/admin/users/bootstrap/password', { token: admin, confirmation: nonce, body: passwordBody })).status).toBe(200);
    expect((await request('GET', '/api/auth/me', { token: admin })).status).toBe(401);
    const login = await request('POST', '/api/auth/login', { body: { username: 'bootstrap', password: passwordBody.password } });
    const replacement = login.data.token as string;
    const sessions = await request('GET', '/api/auth/sessions', { token: replacement });
    expect(sessions.status).toBe(200);
    const sessionId = sessions.data.sessions.find((item: { id: string }) => item.id === login.data.auth.session.id)?.id;
    expect(sessionId).toBeTruthy();
    expect((await request('DELETE', `/api/auth/sessions/${sessionId}`, { token: replacement })).status).toBe(200);
    expect((await request('GET', '/api/auth/me', { token: replacement })).status).toBe(401);
  });

  it('persists allowed and denied audit records in Storage', async () => {
    await request('GET', '/api/status');
    const admin = await bootstrap();
    await request('GET', '/api/status', { token: admin });
    const rows = await storage.query<Record<string, unknown>>({ prefix: 'admin-audit:' });
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.some(({ value }) => value.outcome === 'denied' && value.status === 401)).toBe(true);
    expect(rows.some(({ value }) => value.outcome === 'allowed' && value.action === 'runtime.status')).toBe(true);
  });
});
