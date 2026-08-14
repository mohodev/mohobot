import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNullLogger, registerSecret, clearSecrets } from '../core/logger.js';
import { LogBuffer } from '../core/log-buffer.js';
import { MemoryStorage } from '../storage/memory.js';
import { AdminServer } from './server.js';
import { OpsControlFacade } from './ops-control.js';
import { DebugChatFacade } from './debug-chat.js';
import {TaskManager}from'../core/task-manager.js';import{TaskControlFacade}from'./task-control.js';

interface Reply { status: number; headers: Headers; data: Record<string, any> }

describe('AdminServer production authorization chain', () => {
  let root: string;
  let storage: MemoryStorage;
  let server: AdminServer;
  let logs: LogBuffer;
  let base: string; let taskManager:TaskManager;
  const master = 'master-token-for-integration-tests';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mohobot-admin-server-'));
    await fs.mkdir(path.join(root, 'webui'), { recursive: true });
    await fs.writeFile(path.join(root, 'webui', 'index.html'), '<h1>Moho</h1>');
    clearSecrets();logs=new LogBuffer({capacity:3});
    storage = new MemoryStorage({ logger: createNullLogger() });
    await storage.init(); taskManager=new TaskManager({logger:createNullLogger()});taskManager.spawn(async()=>{}, {name:'world-tick',intervalMs:60_000});
    server = new AdminServer({
      rootDir: root, host: '127.0.0.1', port: 0, token: master, logger: createNullLogger(), storage, snapshots: () => [],
      remoteHealth: async () => ({ mysql: { ok: true } }), modelHealth: async () => ({ reply: { ok: true } }),
      configPublication: { get: async () => ({ version: 1 }), publish: async (input, principal) => ({ ...input, actor: principal.id }) },
      ops:new OpsControlFacade({storage,listTasks:()=>taskManager.list()}),taskControl:new TaskControlFacade({tasks:taskManager}),logs,
      debugChat:new DebugChatFacade({providers:()=>[{id:'main',provider:{name:'mock',model:'mock-model',health:async()=>({ok:true}),chat:async()=>({content:'debug response',model:'mock-model',ms:1})}}],logger:createNullLogger(),requestsPerMinute:1,maxInputChars:8}),
    });
    await server.start();
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server.stop();
    await taskManager.stopAll(); await storage.close();
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

  it('offers isolated debug chat only to operators with bounded input and redacted traces',async()=>{const admin=await bootstrap();const create={username:'operator-debug',password:'long operator password',role:'operator',enabled:true};const nonce=await confirmation(admin,'POST','/api/admin/users',create);await request('POST','/api/admin/users',{token:admin,confirmation:nonce,body:create});const login=await request('POST','/api/auth/login',{body:{username:'operator-debug',password:'long operator password'}});const operator=login.data.token;expect((await request('GET','/api/debug/chat/capabilities',{token:operator})).data.capabilities.bots).toEqual([{id:'main',model:'mock-model',available:true}]);const reply=await request('POST','/api/debug/chat',{token:operator,body:{botId:'main',content:'hello'}});expect(reply.status).toBe(200);expect(reply.data.reply.content).toBe('debug response');expect(JSON.stringify(reply.data.reply.trace)).not.toContain('hello');expect((await request('POST','/api/debug/chat',{token:operator,body:{botId:'main',content:'too long input'}})).status).toBe(400);expect((await request('POST','/api/debug/chat',{token:operator,body:{botId:'main',content:'again'}})).status).toBe(429);const viewerCreate={username:'viewer-debug',password:'long viewer password',role:'viewer',enabled:true};const viewerNonce=await confirmation(admin,'POST','/api/admin/users',viewerCreate);await request('POST','/api/admin/users',{token:admin,confirmation:viewerNonce,body:viewerCreate});const viewer=(await request('POST','/api/auth/login',{body:{username:'viewer-debug',password:'long viewer password'}})).data.token;expect((await request('GET','/api/debug/chat/capabilities',{token:viewer})).status).toBe(403);});
  it('controls only registered safe interval tasks after confirmation',async()=>{const admin=await bootstrap();const tasks=(await request('GET','/api/tasks',{token:admin})).data.tasks.items;const task=tasks[0];expect(task.controlName).toBe('world-tick');expect((await request('POST',`/api/tasks/${task.id}/pause`,{token:admin,body:{}})).status).toBe(409);const pause=await confirmation(admin,'POST',`/api/tasks/${task.id}/pause`,{});expect((await request('POST',`/api/tasks/${task.id}/pause`,{token:admin,confirmation:pause,body:{}})).data.task.state).toBe('paused');const resume=await confirmation(admin,'POST',`/api/tasks/${task.id}/resume`,{});expect((await request('POST',`/api/tasks/${task.id}/resume`,{token:admin,confirmation:resume,body:{}})).data.task.state).toBe('pending');expect((await request('POST','/api/tasks/nope/run',{token:admin,body:{}})).status).toBe(409);});

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
    const createNonce = await confirmation(admin, 'POST', '/admin/users', createBody);
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

  it('accepts stable user ids from the WebUI for updates', async()=>{const admin=await bootstrap();const users=await request('GET','/api/admin/users',{token:admin});const id=users.data.users[0].id as string;const body={username:'renamed'};const nonce=await confirmation(admin,'PATCH',`/api/admin/users/${encodeURIComponent(id)}`,body);expect((await request('PATCH',`/api/admin/users/${encodeURIComponent(id)}`,{token:admin,confirmation:nonce,body})).status).toBe(200);});

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

  it('exposes narrow redacted ops controls with RBAC and confirmations',async()=>{const admin=await bootstrap();const session={kind:'session',recordVersion:1,key:'session:main:channel:user',botId:'main',channelId:'channel',userId:'user',messages:[{role:'user',content:'private session body'}],updatedAt:5};await storage.save(session.key,session);await storage.save('outbox:failed-1',{eventId:'failed-1',type:'message.updated',payload:{token:'private payload'},status:'failed',attempts:2,createdAt:1,updatedAt:2,nextAttemptAt:9,lastError:'private remote error'});await storage.save('outbox:done-1',{eventId:'done-1',type:'message.updated',payload:{},status:'done',attempts:1,createdAt:1,updatedAt:2,nextAttemptAt:2});const sessions=await request('GET','/api/ops/sessions?botId=main&limit=1',{token:admin});expect(sessions.status).toBe(200);expect(JSON.stringify(sessions.data)).not.toContain('private session');const outbox=await request('GET','/api/ops/outbox?status=failed',{token:admin});expect(outbox.status).toBe(200);expect(JSON.stringify(outbox.data)).not.toContain('private payload');expect(JSON.stringify(outbox.data)).not.toContain('private remote');expect((await request('GET','/api/tasks',{token:admin})).data.tasks.items[0]).toMatchObject({name:'world-tick'});expect((await request('DELETE',`/api/ops/sessions/${encodeURIComponent(session.key)}`,{token:admin})).status).toBe(409);const delNonce=await confirmation(admin,'DELETE',`/api/ops/sessions/${encodeURIComponent(session.key)}`,{});expect((await request('DELETE',`/api/ops/sessions/${encodeURIComponent(session.key)}`,{token:admin,confirmation:delNonce})).status).toBe(200);const retryBody={};const retryNonce=await confirmation(admin,'POST','/api/ops/outbox/failed-1/retry',retryBody);expect((await request('POST','/api/ops/outbox/failed-1/retry',{token:admin,confirmation:retryNonce,body:retryBody})).data.event.status).toBe('pending');const doneNonce=await confirmation(admin,'POST','/api/ops/outbox/done-1/retry',{});expect((await request('POST','/api/ops/outbox/done-1/retry',{token:admin,confirmation:doneNonce,body:{}})).status).toBe(409);expect((await request('DELETE','/api/ops/sessions/not-a-session-key',{token:admin})).status).toBe(409);});

  it('polls redacted structured logs with gap and filters under logs.read',async()=>{const secret='log-api-secret-value-123';registerSecret(secret);logs.write({level:'info',bindings:{component:'runtime'},message:'one'});logs.write({level:'warn',bindings:{component:'discord'},message:`failure ${secret}`,data:{token:secret,content:'private chat',prompt:'private prompt',safe:`masked ${secret}`}});logs.write({level:'error',bindings:{component:'runtime'},message:'three'});logs.write({level:'error',bindings:{component:'runtime'},message:'four'});logs.write({level:'info',bindings:{component:'other'},message:'five'});expect((await request('GET','/api/logs')).status).toBe(401);const admin=await bootstrap();const result=await request('GET','/api/logs?after=1&limit=1&level=error&component=runtime',{token:admin});expect(result.status).toBe(200);expect(result.data.logs).toMatchObject({gap:true,oldestSeq:3,latestSeq:5,items:[{seq:3,level:'error',component:'runtime',message:'three'}]});const all=await request('GET','/api/logs',{token:admin});const serialized=JSON.stringify(all.data);expect(serialized).not.toContain(secret);expect(serialized).not.toContain('private chat');expect(serialized).not.toContain('private prompt');expect((await request('GET','/api/logs?limit=501',{token:admin})).status).toBe(400);expect((await request('GET','/api/logs?level=nope',{token:admin})).status).toBe(400);});

  it('filters and paginates audit records through the strict ops facade',async()=>{const admin=await bootstrap();await request('GET','/api/status',{token:admin});const result=await request('GET','/api/admin/audit?actor=bootstrap&outcome=allowed&method=GET&limit=1&offset=0',{token:admin});expect(result.status).toBe(200);expect(result.data.audit).toMatchObject({limit:1,offset:0,items:expect.any(Array)});expect(result.data.audit.items.every((item:any)=>item.actor==='bootstrap'&&item.outcome==='allowed'&&item.method==='GET')).toBe(true);expect((await request('GET','/api/admin/audit?limit=101',{token:admin})).status).toBe(400);});
  it('enforces memory metadata/detail/delete permissions and confirmation',async()=>{await storage.save('semantic-memory:main:u:1:id',{id:'id',botId:'main',channelId:'dm:u',userId:'u',scope:'private',text:'private body',user:{role:'user',content:'private'},assistant:{role:'assistant',content:'reply'},createdAt:1});const admin=await bootstrap();const create={username:'viewer-memory',password:'long viewer password',role:'viewer',enabled:true};let nonce=await confirmation(admin,'POST','/api/admin/users',create);await request('POST','/api/admin/users',{token:admin,confirmation:nonce,body:create});const login=await request('POST','/api/auth/login',{body:{username:'viewer-memory',password:'long viewer password'}});const viewer=login.data.token;const list=await request('GET','/api/memory',{token:viewer});expect(list.status).toBe(200);expect(JSON.stringify(list.data)).not.toContain('private body');const key=encodeURIComponent(list.data.memories[0].key);expect((await request('GET',`/api/memory/${key}`,{token:viewer})).status).toBe(403);expect((await request('DELETE',`/api/memory/${key}`,{token:admin})).status).toBe(409);nonce=await confirmation(admin,'DELETE',`/api/memory/${key}`,{});expect((await request('DELETE',`/api/memory/${key}`,{token:admin,confirmation:nonce})).status).toBe(200);});

  it('supports revisioned character details and rejects stale updates',async()=>{const admin=await bootstrap();const create={id:'alice',name:'Alice',prompt:'A sufficiently long character prompt for tests.'};let nonce=await confirmation(admin,'POST','/api/characters',create);expect((await request('POST','/api/characters',{token:admin,confirmation:nonce,body:create})).status).toBe(201);const detail=await request('GET','/api/characters/alice',{token:admin});expect(detail.data.character.prompt).toContain('sufficiently');const update={name:'Alice',prompt:'A sufficiently long updated character prompt.',expectedRevision:detail.data.character.revision};nonce=await confirmation(admin,'PUT','/api/characters/alice',update);expect((await request('PUT','/api/characters/alice',{token:admin,confirmation:nonce,body:update})).status).toBe(200);nonce=await confirmation(admin,'PUT','/api/characters/alice',update);expect((await request('PUT','/api/characters/alice',{token:admin,confirmation:nonce,body:update})).status).toBe(409);});

  it('strictly validates device/affinity and dry-runs behavior without writes',async()=>{const admin=await bootstrap();expect((await request('POST','/api/device/transition',{token:admin,body:{battery:'50'}})).status).toBe(400);const affinity={botId:'main',userId:'u',delta:11};const affinityNonce=await confirmation(admin,'POST','/api/affinity/adjust',affinity);expect((await request('POST','/api/affinity/adjust',{token:admin,confirmation:affinityNonce,body:affinity})).status).toBe(400);const beforeWorld=JSON.stringify((await request('GET','/api/world',{token:admin})).data.world),beforeDevice=JSON.stringify((await request('GET','/api/device',{token:admin})).data.device);const dry={botId:'main',channelId:'dm:u',dm:true,userId:'u',content:'hello',mentionsBot:false,recentReplies:0};const result=await request('POST','/api/behavior/dry-run',{token:admin,body:dry});expect(result.status).toBe(200);expect(result.data.result.decision.reason).toBe('direct');expect(JSON.stringify((await request('GET','/api/world',{token:admin})).data.world)).toBe(beforeWorld);expect(JSON.stringify((await request('GET','/api/device',{token:admin})).data.device)).toBe(beforeDevice);});

  it('enforces knowledge base RBAC, confirmation and JSON-safe plain text responses',async()=>{const admin=await bootstrap();const payload={id:'kb-one',name:'<img src=x onerror=alert(1)>',description:'local'};expect((await request('POST','/api/knowledge-bases',{token:admin,body:payload})).status).toBe(409);const nonce=await confirmation(admin,'POST','/knowledge-bases',payload);const created=await request('POST','/api/knowledge-bases',{token:admin,confirmation:nonce,body:payload});expect(created.status).toBe(201);const doc={name:'doc',text:'<script>alert(1)</script> alpha alpha'};const docNonce=await confirmation(admin,'POST','/knowledge-bases/kb-one/documents',doc);expect((await request('POST','/api/knowledge-bases/kb-one/documents',{token:admin,confirmation:docNonce,body:doc})).status).toBe(200);const search=await request('GET','/api/knowledge-bases/kb-one/search?q=alpha',{token:admin});expect(search.status).toBe(200);expect(JSON.stringify(search.data)).toContain('<script>');const users={username:'kb-viewer',password:'long viewer password',role:'viewer',enabled:true};const userNonce=await confirmation(admin,'POST','/admin/users',users);await request('POST','/api/admin/users',{token:admin,confirmation:userNonce,body:users});const login=await request('POST','/api/auth/login',{body:{username:'kb-viewer',password:'long viewer password'}});expect((await request('POST','/api/knowledge-bases',{token:login.data.token,body:{name:'no'}})).status).toBe(403);});

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
