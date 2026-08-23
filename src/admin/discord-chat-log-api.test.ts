import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNullLogger } from '../core/logger.js';
import { DiscordChatLogBuffer } from '../core/discord-chat-log.js';
import { MemoryStorage } from '../storage/memory.js';
import { AdminServer } from './server.js';
import { can, permissionsFor } from './rbac.js';
import { routePolicy } from './route-policy.js';

interface Reply { status: number; data: Record<string, any> }

describe('admin Discord chat log API', () => {
  let root: string;
  let storage: MemoryStorage;
  let server: AdminServer;
  let chatLog: DiscordChatLogBuffer;
  let base: string;
  const master = 'master-token-for-integration-tests';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mohobot-discord-chat-log-'));
    await fs.mkdir(path.join(root, 'webui'), { recursive: true });
    await fs.writeFile(path.join(root, 'webui', 'index.html'), '<h1>Moho</h1>');
    storage = new MemoryStorage({ logger: createNullLogger() });
    await storage.init();
    chatLog = new DiscordChatLogBuffer();
    server = new AdminServer({
      rootDir: root, host: '127.0.0.1', port: 0, token: master, logger: createNullLogger(), storage, snapshots: () => [],
      discordChatLog: chatLog,
    });
    await server.start();
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server.stop();
    await storage.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function request(pathname: string, token?: string): Promise<Reply> {
    const response = await fetch(`${base}${pathname}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: response.status, data: await response.json() as Record<string, any> };
  }

  async function bootstrap(): Promise<string> {
    const created = await fetch(`${base}/api/auth/bootstrap/session`, { method: 'POST', headers: { 'x-admin-token': master, 'x-admin-actor': 'test' } });
    return ((await created.json()) as Record<string, any>).token as string;
  }

  async function login(role: 'viewer' | 'operator'): Promise<string> {
    const admin = await bootstrap();
    const body = { username: `${role}-chat`, password: `long ${role} password`, role, enabled: true };
    const confirmed = await fetch(`${base}/api/confirmations`, { method: 'POST', headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'POST', path: '/api/admin/users', body }) });
    expect(confirmed.status).toBe(201);
    const nonce = ((await confirmed.json() as Record<string, any>).confirmation as Record<string, any>).nonce as string;
    const created = await fetch(`${base}/api/admin/users`, { method: 'POST', headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json', 'x-admin-confirmation': nonce }, body: JSON.stringify(body) });
    expect(created.status).toBe(201);
    const session = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: body.username, password: body.password }) });
    return ((await session.json()) as Record<string, any>).token as string;
  }

  it('guards the route with the dedicated chats.log.read permission', () => {
    const policy = routePolicy('GET', '/api/ops/discord-chat-log');
    expect(policy).toMatchObject({ permission: 'chats.log.read', risk: 'read', confirmation: false });
    expect(can({ id: 'v', role: 'viewer', enabled: true }, 'chats.log.read')).toBe(false);
    expect(can({ id: 'o', role: 'operator', enabled: true }, 'chats.log.read')).toBe(true);
    expect(permissionsFor('viewer')).not.toContain('chats.log.read');
  });

  it('denies viewers without the permission and serves operators bounded entries', async () => {
    chatLog.record({ platform: 'discord', direction: 'in', botId: 'main', channelId: 'chan-7', userId: 'user-1', content: 'hi there', outcome: 'received', traceId: 'ct_1', time: 111 });
    chatLog.record({ platform: 'discord', direction: 'out', botId: 'main', channelId: 'chan-7', userId: 'main', content: 'r'.repeat(600), outcome: 'delivered', traceId: 'ct_2', time: 222 });

    const viewer = await login('viewer');
    expect((await request('/api/ops/discord-chat-log', viewer)).status).toBe(403);

    const operator = await login('operator');
    const ok = await request('/api/ops/discord-chat-log?limit=10', operator);
    expect(ok.status).toBe(200);
    const messages = ok.data.messages as Array<Record<string, any>>;
    expect(messages).toHaveLength(2);
    expect(messages[0]!).toMatchObject({ direction: 'out', botId: 'main', channelId: 'chan-7', userId: 'main', traceId: 'ct_2', outcome: 'delivered' });
    expect(messages[0]!.summary).toHaveLength(500);
    expect(messages[0]!.time).toBe(222);
    expect(messages[1]!).toMatchObject({ direction: 'in', userId: 'user-1', summary: 'hi there', outcome: 'received' });

    expect((await request('/api/ops/discord-chat-log?direction=in', operator)).data.messages).toHaveLength(1);
    expect((await request('/api/ops/discord-chat-log?channelId=chan-7&botId=main', operator)).data.messages).toHaveLength(2);
    expect((await request('/api/ops/discord-chat-log?direction=sideways', operator)).status).toBe(400);
    expect((await request('/api/ops/discord-chat-log?limit=500', operator)).status).toBe(400);
    expect(JSON.stringify(ok.data)).not.toContain('r'.repeat(501));
  });

  it('fails closed with 409 when no chat log is wired and ignores unauthenticated callers', async () => {
    const bare = new AdminServer({ rootDir: root, host: '127.0.0.1', port: 0, token: master, logger: createNullLogger(), storage, snapshots: () => [] });
    await bare.start();
    try {
      const operator = await login('operator');
      expect((await request('/api/ops/discord-chat-log', operator)).status).toBe(200);
      // Sessions live in the shared storage, so a main-server token also authorizes the bare server.
      expect((await fetch(`http://127.0.0.1:${bare.port}/api/ops/discord-chat-log`)).status).toBe(401);
      expect((await fetch(`http://127.0.0.1:${bare.port}/api/ops/discord-chat-log`, { headers: { authorization: `Bearer ${operator}` } })).status).toBe(409);
    } finally {
      await bare.stop();
    }
  });
});
