import { describe, expect, it } from 'vitest';
import { actionDigest, ConfirmationStore } from './confirmation.js';
import type { AdminPrincipal } from './rbac.js';

const operator: AdminPrincipal = { id: 'operator-1', role: 'operator', enabled: true };
const admin: AdminPrincipal = { id: 'admin-1', role: 'admin', enabled: true };

const request = (overrides: Partial<Parameters<ConfirmationStore['issue']>[0]> = {}) => ({
  principal: operator,
  permission: 'world.write' as const,
  action: 'world.schedule.confirm',
  payload: { eventId: 'event-1', trust: 'confirmed' },
  ...overrides,
});

describe('ConfirmationStore', () => {
  it('binds a one-time nonce to principal, permission, action, and payload digest', () => {
    const store = new ConfirmationStore({ pepper: Buffer.alloc(32, 4) });
    const issued = store.issue(request());
    expect(issued.actionDigest).toBe(actionDigest(request()));
    expect(store.consume(issued.nonce, request())).toBe(true);
    expect(store.consume(issued.nonce, request())).toBe(false);
    expect(store.pending()).toBe(0);
  });

  it('rejects action, payload, permission, and principal substitution', () => {
    for (const changed of [
      request({ action: 'world.schedule.delete' }),
      request({ payload: { eventId: 'event-2', trust: 'confirmed' } }),
      request({ permission: 'status.read' }),
      request({ principal: { id: 'operator-2', role: 'operator', enabled: true } }),
    ]) {
      const store = new ConfirmationStore({ pepper: Buffer.alloc(32, 5) });
      const issued = store.issue(request());
      expect(store.consume(issued.nonce, changed)).toBe(false);
      expect(store.consume(issued.nonce, request())).toBe(true);
    }
  });

  it('expires challenges and allows explicit revocation', () => {
    let now = 100;
    const store = new ConfirmationStore({ ttlMs: 10, now: () => now, pepper: Buffer.alloc(32, 6) });
    const expired = store.issue(request());
    now = 110;
    expect(store.consume(expired.nonce, request())).toBe(false);
    const revoked = store.issue(request());
    expect(store.revoke(revoked.nonce)).toBe(true);
    expect(store.consume(revoked.nonce, request())).toBe(false);
  });

  it('requires current RBAC permission at issue and consume time', () => {
    const store = new ConfirmationStore({ pepper: Buffer.alloc(32, 7) });
    expect(() => store.issue(request({ principal: { id: 'viewer', role: 'viewer', enabled: true } }))).toThrow('forbidden');
    const issued = store.issue({ principal: admin, permission: 'config.publish', action: 'config.publish', payload: { revision: 3 } });
    expect(store.consume(issued.nonce, { principal: { ...admin, role: 'operator' }, permission: 'config.publish', action: 'config.publish', payload: { revision: 3 } })).toBe(false);
  });

  it('canonicalizes object keys but detects meaningful payload changes', () => {
    expect(actionDigest(request({ payload: { b: 2, a: 1 } }))).toBe(actionDigest(request({ payload: { a: 1, b: 2 } })));
    expect(actionDigest(request({ payload: [1, 2] }))).not.toBe(actionDigest(request({ payload: [2, 1] })));
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => actionDigest(request({ payload: cycle }))).toThrow('cycle');
  });
});
