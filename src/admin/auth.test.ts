import { describe, expect, it } from 'vitest';
import { AdminSessionStore } from './auth.js';
import type { AdminPrincipal } from './rbac.js';

const admin: AdminPrincipal = { id: 'admin-1', role: 'admin', enabled: true };

describe('AdminSessionStore', () => {
  it('creates random-looking sessions without retaining plaintext tokens in diagnostics', () => {
    let byte = 1;
    const store = new AdminSessionStore({ randomBytes: (size) => Buffer.alloc(size, byte++), pepper: Buffer.alloc(32, 9) });
    const first = store.create(admin);
    const second = store.create(admin);
    expect(first.token).not.toBe(second.token);
    expect(store.authenticate(first.token)?.principal).toEqual(admin);
    expect(JSON.stringify(store.list())).not.toContain(first.token);
    expect(store.list()[0]).not.toHaveProperty('tokenHash');
  });

  it('expires, sweeps, and revokes sessions', () => {
    let now = 100;
    const store = new AdminSessionStore({ ttlMs: 10, now: () => now, pepper: Buffer.alloc(32, 1) });
    const one = store.create(admin);
    const two = store.create(admin);
    expect(store.revoke(one.token)).toBe(true);
    expect(store.authenticate(one.token)).toBeUndefined();
    now = 110;
    expect(store.authenticate(two.token)).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  it('revokes all sessions for one principal without affecting another', () => {
    const store = new AdminSessionStore({ pepper: Buffer.alloc(32, 2) });
    const first = store.create(admin);
    const other = store.create({ id: 'viewer', role: 'viewer', enabled: true });
    expect(store.revokePrincipal(admin.id)).toBe(1);
    expect(store.authenticate(first.token)).toBeUndefined();
    expect(store.authenticate(other.token)).toBeDefined();
  });

  it('rejects disabled principals and invalid tokens', () => {
    const store = new AdminSessionStore({ pepper: Buffer.alloc(32, 3) });
    expect(() => store.create({ ...admin, enabled: false })).toThrow();
    expect(store.authenticate('')).toBeUndefined();
    expect(store.authenticate('x'.repeat(513))).toBeUndefined();
  });
});
