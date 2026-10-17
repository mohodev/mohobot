import { describe, expect, it } from 'vitest';

import type { ScopedStorage } from '../../src/storage/types.js';
import {
  authorize,
  consume,
  redactArgs,
  stage,
  readAudit,
  audit,
  type AuditEntry,
  type OperatorEnv,
  type OperatorTool,
} from './registry.js';
import {
  operatorTools,
  parseGitArgs,
  parseVerifyArgs,
  isSafeRepoPath,
  VERIFY_SCRIPTS,
} from './tools.js';

const DEFAULTS = { timeoutMs: 180_000, timeoutMaxMs: 600_000 };

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

describe('git argument validation', () => {
  it('only allows read subcommands', () => {
    for (const sub of ['status', 'log', 'diff', 'show']) {
      expect(parseGitArgs([sub, sub === 'show' ? 'abc1234' : undefined as never].filter(Boolean)).ok).toBe(true);
    }
    expect(parseGitArgs(['push']).ok).toBe(false);
    expect(parseGitArgs(['commit', '-m', 'x']).ok).toBe(false);
    expect(parseGitArgs(['reset', '--hard']).ok).toBe(false);
    expect(parseGitArgs(['clean', '-fd']).ok).toBe(false);
    expect(parseGitArgs(['checkout', 'master']).ok).toBe(false);
    expect(parseGitArgs([]).ok).toBe(false);
  });

  it('builds the intended argv', () => {
    expect(parseGitArgs(['status'])).toEqual({ ok: true, argv: ['status', '--porcelain=v1', '--branch'] });
    expect(parseGitArgs(['log', '5'])).toEqual({ ok: true, argv: ['log', '--max-count=5', '--format=%h %ad %an %s', '--date=short'] });
    expect(parseGitArgs(['diff', 'src/pipeline/pipeline.ts'])).toEqual({
      ok: true,
      argv: ['diff', '--stat', '--', 'src/pipeline/pipeline.ts'],
    });
  });

  it('bounds log counts', () => {
    for (const bad of ['0', '101', '1000', '-1', 'abc', '']) {
      expect(parseGitArgs(['log', bad]).ok).toBe(false);
    }
    expect(parseGitArgs(['log', '100']).ok).toBe(true);
  });

  it('rejects traversal and absolute paths in diff', () => {
    expect(isSafeRepoPath('../data/.env')).toBe(false);
    expect(isSafeRepoPath('data/../../etc/passwd')).toBe(false);
    expect(isSafeRepoPath('/etc/passwd')).toBe(false);
    expect(isSafeRepoPath('~/.ssh/id_rsa')).toBe(false);
    expect(isSafeRepoPath('data/config/global.yaml')).toBe(true);
    expect(parseGitArgs(['diff', '../../data/.env']).ok).toBe(false);
  });

  it('validates the show revision', () => {
    expect(parseGitArgs(['show', '9f13d0a']).ok).toBe(true);
    expect(parseGitArgs(['show', 'HEAD']).ok).toBe(false);
    expect(parseGitArgs(['show', '$(cat data/.env)']).ok).toBe(false);
    expect(parseGitArgs(['show']).ok).toBe(false);
  });
});

describe('verify argument validation', () => {
  it('only allows offline offline scripts', () => {
    for (const script of VERIFY_SCRIPTS) {
      expect(parseVerifyArgs([script], DEFAULTS).ok).toBe(true);
    }
    for (const bad of ['deploy', 'update', 'start', '']) {
      expect(parseVerifyArgs([bad], DEFAULTS).ok).toBe(false);
    }
  });

  it('clamps the timeout to the configured ceiling', () => {
    expect(parseVerifyArgs(['test'], DEFAULTS)).toEqual({
      ok: true,
      argv: [String(180_000), 'test'],
    });
    expect(parseVerifyArgs(['test', '900'], DEFAULTS)).toEqual({
      ok: true,
      argv: [String(600_000), 'test'],
    });
    expect(parseVerifyArgs(['test', '30'], DEFAULTS)).toEqual({
      ok: true,
      argv: ['30000', 'test'],
    });
    expect(parseVerifyArgs(['test', '0'], DEFAULTS).ok).toBe(true);
    expect(parseVerifyArgs(['test', 'abc'], DEFAULTS).ok).toBe(false);
  });
});

describe('registered tools', () => {
  it('exposes git as read and verify as confirmed write', () => {
    const git = operatorTools.find((entry) => entry.name === 'git')!;
    const verify = operatorTools.find((entry) => entry.name === 'verify')!;
    expect(git.risk).toBe('read');
    expect(git.confirm).toBeUndefined();
    expect(verify.risk).toBe('write');
    expect(verify.confirm).toBe(true);
  });

  it('returns the redacted failure body when git exits non-zero', async () => {
    const git = operatorTools.find((entry) => entry.name === 'git')!;
    const result = await git.run(['log'], env({
      exec: async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository' }),
    }));
    expect(result.ok).toBe(false);
    expect(result.output).toContain('128');
    expect(result.output).not.toContain('Token');
  });

  it('reports a green verify run', async () => {
    const verify = operatorTools.find((entry) => entry.name === 'verify')!;
    const result = await verify.run(['typecheck'], env({
      exec: async (_cmd, args) => {
        expect(args).toEqual(['run', '--silent', 'typecheck', '--prefix', '/repo']);
        return { code: 0, stdout: 'ok', stderr: '' };
      },
    }));
    expect(result.ok).toBe(true);
    expect(result.output).toContain('typecheck 通过');
  });
});
