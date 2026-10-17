import { describe, expect, it } from 'vitest';

import type { ScopedStorage } from '../storage/types.js';
import {
  authorize,
  consume,
  getProcessBootId,
  redactArgs,
  setProcessBootIdForTests,
  stage,
  readAudit,
  audit,
  type AuditEntry,
  type OperatorEnv,
  type OperatorTool,
} from './registry.js';

function storage() {
  const store = new Map<string, unknown>();
  return {
    store,
    iface: {
      async get<T>(key: string) { return store.get(key) as T | undefined; },
      async save<T>(key: string, value: T) { store.set(key, value); },
      async delete(key: string) { store.delete(key); },
      async query() { return []; },
    },
  };
}

function tool(overrides: Partial<OperatorTool> = {}): OperatorTool {
  return {
    name: 'probe',
    risk: 'read',
    usage: '?op probe',
    description: 'probe tool',
    async run() { return { ok: true, output: 'ran' }; },
    ...overrides,
  };
}

function env(overrides: Partial<OperatorEnv> = {}): OperatorEnv {
  return {
    callerId: 'admin-1',
    isAdmin: true,
    storage: storage().iface,
    logger: { warn() {}, error() {}, info() {} } as unknown as OperatorEnv['logger'],
    rootDir: '/repo',
    exec: async () => ({ code: 0, stdout: '', stderr: '' }),
    ...overrides,
  };
}

describe('policy', () => {
  it('refuses callers with no identity', () => {
    expect(authorize(tool(), { callerId: '', isAdmin: true })).toEqual({ kind: 'deny', reason: '缺少调用者身份' });
  });

  it('refuses non-admins before anything else', () => {
    expect(authorize(tool({ name: 'git' }), { callerId: 'u1', isAdmin: false }).kind).toBe('deny');
    expect(authorize(tool({ risk: 'danger' }), { callerId: 'u1', isAdmin: false }).kind).toBe('deny');
  });

  it('refuses danger tools outright - destructive work is not done inside the bot', () => {
    const decision = authorize(tool({ risk: 'danger' }), { callerId: 'admin-1', isAdmin: true });
    expect(decision).toMatchObject({ kind: 'deny' });
  });

  it('lets read tools run immediately and stages confirmed ones', () => {
    expect(authorize(tool({ risk: 'read' }), { callerId: 'admin-1', isAdmin: true }))
      .toEqual({ kind: 'allow', stagingRequired: false });
    expect(authorize(tool({ risk: 'write', confirm: true }), { callerId: 'admin-1', isAdmin: true }))
      .toEqual({ kind: 'allow', stagingRequired: true });
    // `write` without confirm is still gated by default in the registry lookup
    expect(authorize(tool({ risk: 'write' }), { callerId: 'admin-1', isAdmin: true }).kind).toBe('allow');
  });
});

describe('audit', () => {
  it('redacts long argument lists and keeps them short', () => {
    expect(redactArgs(['git', 'show', 'abc123'])).toBe('git show abc123');
    expect(redactArgs(['x'.repeat(900)])).toMatch(/…$/);
    expect(redactArgs(['x'.repeat(900)]).length).toBeLessThanOrEqual(402);
  });

  it('caps the trail and still writes', async () => {
    const store = storage();
    for (let i = 0; i < 250; i += 1) {
      await audit({ storage: store.iface, logger: { warn() {} } as unknown as OperatorEnv['logger'] }, {
        ts: i, tool: 'git', args: '', caller: 'admin-1', outcome: 'ok',
      });
    }
    const entries = await readAudit(store.iface);
    expect(entries).toHaveLength(200);
    expect(entries[0]!.ts).toBe(50);
  });

  it('survives a broken storage instead of throwing', async () => {
    const broken = {
      async get() { throw new Error('down'); },
      async save() { throw new Error('down'); },
      async delete() { throw new Error('down'); },
      async query() { throw new Error('down'); },
    };
    await expect(
      audit({ storage: broken as unknown as ScopedStorage, logger: { warn() {} } as unknown as OperatorEnv['logger'] }, {
        ts: 1, tool: 'git', args: '', caller: 'a', outcome: 'ok',
      }),
    ).resolves.toBeUndefined();
    expect(await readAudit(broken as unknown as ScopedStorage)).toEqual([]);
  });
});

describe('two-step confirm', () => {
  it('is single-use and binds to the caller', async () => {
    const store = storage();
    const code = await stage({ storage: store.iface }, 'verify', ['typecheck'], 'admin-1');
    const first = await consume({ storage: store.iface }, code, 'admin-1', 300_000);
    expect(first.request).toMatchObject({ tool: 'verify', args: ['typecheck'], caller: 'admin-1' });
    expect(first.error).toBeUndefined();

    const second = await consume({ storage: store.iface }, code, 'admin-1', 300_000);
    expect(second.request).toBeUndefined();
    expect(second.error).toContain('没有待确认');
  });

  it('rejects another caller and a wrong code', async () => {
    const store = storage();
    const code = await stage({ storage: store.iface }, 'verify', ['test'], 'admin-1');
    expect((await consume({ storage: store.iface }, code, 'someone-else', 300_000)).error).toContain('其他调用者');
    expect((await consume({ storage: store.iface }, 'deadbeef', 'admin-1', 300_000)).error).toContain('无效');
  });

  it('expires stale requests and clears them', async () => {
    const store = storage();
    const code = await stage({ storage: store.iface }, 'verify', ['test'], 'admin-1');
    const later = Date.now() + 600_000;
    const result = await consume({ storage: store.iface }, code, 'admin-1', 300_000, later);
    expect(result.error).toContain('过期');
    expect(store.store.has('pending')).toBe(false);
  });
});

describe('cross-process confirmation', () => {
  it('stamps staged requests with the process boot marker', async () => {
    const store = storage();
    await stage({ storage: store.iface }, 'verify', ['test'], 'admin-1');
    const pending = await store.iface.get<{ bootId?: string }>('pending');
    expect(pending?.bootId).toBe(getProcessBootId());
  });

  it('invalidates pending nonces after a simulated restart and clears them', async () => {
    const store = storage();
    const original = getProcessBootId();
    const code = await stage({ storage: store.iface }, 'restart', [], 'admin-1');
    try {
      // Simulate a process restart: the boot marker rotates.
      setProcessBootIdForTests('a-different-boot');
      const result = await consume({ storage: store.iface }, code, 'admin-1', 300_000);
      expect(result.request).toBeUndefined();
      expect(result.error).toContain('进程已重启');
      expect(store.store.has('pending')).toBe(false);
    } finally {
      setProcessBootIdForTests(original);
    }
  });

  it('rejects legacy pending entries staged before boot markers existed', async () => {
    const store = storage();
    await store.iface.save('pending', { nonce: 'abc123', tool: 'verify', args: ['test'], caller: 'admin-1', createdAt: Date.now() });
    const result = await consume({ storage: store.iface }, 'abc123', 'admin-1', 300_000);
    expect(result.request).toBeUndefined();
    expect(result.error).toContain('已失效');
    expect(store.store.has('pending')).toBe(false);
  });
});
