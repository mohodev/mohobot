import { describe, expect, it } from 'vitest';

import type { OperatorEnv } from './registry.js';
import {
  listOperatorToolDescriptors,
  operatorTools,
  parseGitArgs,
  parseVerifyArgs,
  isSafeRepoPath,
  VERIFY_SCRIPTS,
} from './tools.js';

const DEFAULTS = { timeoutMs: 180_000, timeoutMaxMs: 600_000 };

function env(overrides: Partial<OperatorEnv> = {}): OperatorEnv {
  return {
    callerId: 'admin-1',
    isAdmin: true,
    storage: {
      async get() { return undefined; },
      async save() {},
      async delete() {},
      async query() { return []; },
    },
    logger: { warn() {}, error() {}, info() {} } as unknown as OperatorEnv['logger'],
    rootDir: '/repo',
    exec: async () => ({ code: 0, stdout: '', stderr: '' }),
    ...overrides,
  };
}

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

describe('tool descriptors', () => {
  it('exposes a data-only view without run functions', () => {
    const descriptors = listOperatorToolDescriptors();
    expect(descriptors.length).toBe(operatorTools.length);
    for (const descriptor of descriptors) {
      expect(descriptor).not.toHaveProperty('run');
      expect(typeof descriptor.name).toBe('string');
      expect(['read', 'write', 'danger']).toContain(descriptor.risk);
      expect(typeof descriptor.confirm).toBe('boolean');
    }
    expect(JSON.parse(JSON.stringify(descriptors))).toHaveLength(descriptors.length);
    expect(descriptors.find((d) => d.name === 'restart')).toMatchObject({ risk: 'write', confirm: true });
  });

  it('describes an injected list too', () => {
    const custom = listOperatorToolDescriptors([{
      name: 'x', risk: 'read', usage: '?op x', description: 'd', async run() { return { ok: true, output: '' }; },
    }]);
    expect(custom).toEqual([{ name: 'x', risk: 'read', usage: '?op x', description: 'd', confirm: false }]);
  });
});
