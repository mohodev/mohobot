import { describe, expect, it } from 'vitest';
import { createNullLogger } from '../core/logger.js';
import { MemoryStorage } from '../storage/memory.js';
import { AdminAuthError, AdminAuthService, normalizeAdminUsername, type AdminUserRecord } from './auth-service.js';

async function fixture(options: { now?: () => number; maxFailedLogins?: number; lockoutMs?: number; sessionTtlMs?: number } = {}) {
  const storage = new MemoryStorage({ logger: createNullLogger() });
  await storage.init();
  let random = 0;
  const auth = new AdminAuthService({
    storage,
    ...options,
    randomBytes: (size) => Buffer.alloc(size, ++random),
    scrypt: { N: 1024, r: 8, p: 1, keyLength: 32 },
  });
  return { storage, auth };
}

async function rejectCode(promise: Promise<unknown>, code: AdminAuthError['code']) {
  await expect(promise).rejects.toMatchObject({ code });
}

describe('AdminAuthService', () => {
  it('normalizes usernames uniquely and bootstraps exactly one legacy admin', async () => {
    const { auth, storage } = await fixture();
    expect(normalizeAdminUsername('  Ａlice  ')).toBe('alice');
    const first = await auth.bootstrapLegacy({ username: ' Alice ', password: 'correct horse battery' });
    const second = await auth.bootstrapLegacy({ username: 'ignored', password: 'different password' });
    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({ normalizedUsername: 'alice', role: 'admin', enabled: true, authVersion: 1 });
    await rejectCode(auth.createUser({ username: 'ＡLICE', password: 'another strong password', role: 'viewer' }), 'username_taken');
    const stored = await storage.get<AdminUserRecord>('admin-user:alice');
    expect(stored?.password).toMatchObject({ algorithm: 'scrypt', version: 1, N: 1024, r: 8, p: 1, keyLength: 32 });
    expect(stored?.password.salt).not.toBe('correct horse battery');
    expect(stored?.password.hash).not.toContain('correct horse');
  });

  it('persists hashed sessions and authenticates across service instances', async () => {
    const { auth, storage } = await fixture();
    const user = await auth.createUser({ username: 'admin', password: 'very secure password', role: 'developer' });
    const login = await auth.login('ADMIN', 'very secure password');
    expect(login.token).toMatch(/^mohos_/);
    expect(login.auth.principal).toEqual({ id: user.id, role: 'developer', enabled: true });
    const sessions = await storage.query<Record<string, unknown>>({ prefix: 'admin-session:' });
    expect(sessions).toHaveLength(1);
    expect(JSON.stringify(sessions[0]?.value)).not.toContain(login.token);
    expect(sessions[0]?.value).toHaveProperty('tokenHash');
    const restarted = new AdminAuthService({ storage, scrypt: { N: 1024, r: 8, p: 1, keyLength: 32 } });
    expect((await restarted.authenticate(login.token))?.user.id).toBe(user.id);
    await restarted.revokeSession(login.token);
    expect(await auth.authenticate(login.token)).toBeUndefined();
  });

  it('rate limits failures, locks the account, and unlocks after the window', async () => {
    let now = 1_000;
    const { auth } = await fixture({ now: () => now, maxFailedLogins: 3, lockoutMs: 500 });
    await auth.createUser({ username: 'operator', password: 'right password 123', role: 'operator' });
    await rejectCode(auth.login('operator', 'wrong password 1'), 'invalid_credentials');
    await rejectCode(auth.login('operator', 'wrong password 2'), 'invalid_credentials');
    await rejectCode(auth.login('operator', 'wrong password 3'), 'locked');
    await rejectCode(auth.login('operator', 'right password 123'), 'locked');
    now += 501;
    expect((await auth.login('operator', 'right password 123')).auth.user.failedLoginCount).toBe(0);
  });

  it('invalidates old sessions after role, enabled state, username, or password changes', async () => {
    const { auth } = await fixture();
    await auth.createUser({ username: 'root', password: 'initial password 1', role: 'admin' });
    await auth.createUser({ username: 'backup', password: 'initial password 2', role: 'admin' });

    const roleSession = await auth.login('root', 'initial password 1');
    await auth.updateUser('root', { role: 'operator' });
    expect(await auth.authenticate(roleSession.token)).toBeUndefined();

    await auth.updateUser('root', { role: 'admin' });
    const disabledSession = await auth.login('root', 'initial password 1');
    await auth.updateUser('root', { enabled: false });
    expect(await auth.authenticate(disabledSession.token)).toBeUndefined();

    await auth.updateUser('root', { enabled: true });
    const renamedSession = await auth.login('root', 'initial password 1');
    await auth.updateUser('root', { username: 'Primary' });
    expect(await auth.authenticate(renamedSession.token)).toBeUndefined();
    expect(await auth.getUser('root')).toBeUndefined();

    const passwordSession = await auth.login('primary', 'initial password 1');
    await auth.changePassword('primary', 'replacement password 9');
    expect(await auth.authenticate(passwordSession.token)).toBeUndefined();
    await rejectCode(auth.login('primary', 'initial password 1'), 'invalid_credentials');
    expect((await auth.login('primary', 'replacement password 9')).auth.user.authVersion).toBeGreaterThan(1);
  });

  it('protects the last enabled privileged admin from disable, demotion, and deletion', async () => {
    const { auth } = await fixture();
    await auth.createUser({ username: 'only', password: 'only admin password', role: 'admin' });
    await rejectCode(auth.updateUser('only', { enabled: false }), 'last_admin');
    await rejectCode(auth.updateUser('only', { role: 'operator' }), 'last_admin');
    await rejectCode(auth.deleteUser('only'), 'last_admin');

    await auth.createUser({ username: 'developer', password: 'developer password', role: 'developer' });
    await auth.updateUser('only', { enabled: false });
    await rejectCode(auth.deleteUser('developer'), 'last_admin');
    await auth.updateUser('only', { enabled: true });
    await auth.deleteUser('developer');
    expect((await auth.listUsers()).map((user) => user.username)).toEqual(['only']);
  });

  it('rejects future and malformed user/session records without overwriting them', async()=>{
    const{auth,storage}=await fixture();
    await storage.save('admin-user:future',{kind:'admin-user',recordVersion:2,username:'future'});
    await rejectCode(auth.bootstrapSession({username:'future',initialPassword:'strong bootstrap password'}),'unsupported_record');
    expect(await storage.get<Record<string,unknown>>('admin-user:future')).toMatchObject({recordVersion:2});
    await storage.save('admin-user:broken',{kind:'admin-user',recordVersion:1,username:'broken'});
    await rejectCode(auth.login('broken','strong password'),'unsupported_record');
    expect(await auth.listUsers()).toEqual([]);
    await auth.createUser({username:'valid',password:'valid password 123',role:'viewer'});const login=await auth.login('valid','valid password 123');
    const rows=await storage.query<Record<string,unknown>>({prefix:'admin-session:'});await storage.save(rows[0]!.key,{...rows[0]!.value,recordVersion:2});
    expect(await auth.authenticate(login.token)).toBeUndefined();expect(await auth.listSessions()).toEqual([]);
  });

  it('supports CRUD without exposing password material and revokes all user sessions', async () => {
    const { auth } = await fixture();
    const created = await auth.createUser({ username: 'viewer', password: 'viewer password 123', role: 'viewer' });
    expect(created).not.toHaveProperty('password');
    const one = await auth.login('viewer', 'viewer password 123');
    const two = await auth.login('viewer', 'viewer password 123');
    expect(await auth.revokeUserSessions(created.id)).toBe(2);
    expect(await auth.authenticate(one.token)).toBeUndefined();
    expect(await auth.authenticate(two.token)).toBeUndefined();
    await auth.updateUser('viewer', { username: 'Auditor', role: 'operator' });
    expect(await auth.getUser('AUDITOR')).toMatchObject({ username: 'Auditor', role: 'operator' });
    await auth.deleteUser('auditor');
    expect(await auth.listUsers()).toEqual([]);
  });
});
