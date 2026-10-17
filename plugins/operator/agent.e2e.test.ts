/**
 * End-to-end test of the operator agent loop (`?op agent <goal>`).
 *
 * Drives the real `runAgent` from ./index.ts with a scripted mock provider and
 * a fake `exec`, so the whole ReAct loop runs with no model, no network and no
 * spawned process:
 *
 *  - the system prompt lists the registered tools and the call options are the
 *    admin task at temperature 0.2;
 *  - read tools execute directly and their output is fed back as the next
 *    observation;
 *  - a `{"final":...}` reply ends the loop with a user-facing summary plus the
 *    per-step trace, and the audit trail records `tool: 'agent'`;
 *  - a write tool is staged instead of executed — the reply asks for
 *    `?op confirm <code>` and nothing reaches exec;
 *  - an unknown tool name does not crash the loop: the refusal becomes the
 *    observation and the model continues.
 */

import { describe, expect, it } from 'vitest';

import type { ScopedStorage } from '../../src/storage/types.js';
import { runAgent } from './index.js';
import { readAudit, type OperatorEnv } from './registry.js';
import { operatorTools } from './tools.js';

const GIT_STATUS = '## main...origin/main\n M plugins/operator/index.ts\n';

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

/** Fake exec: canned git/npm output, every invocation recorded for asserts. */
function fakeExec(calls: string[][]): OperatorEnv['exec'] {
  return async (command, args) => {
    calls.push([command, ...args]);
    if (command === 'git') return { code: 0, stdout: GIT_STATUS, stderr: '' };
    if (command === 'npm') return { code: 0, stdout: 'ok', stderr: '' };
    return { code: 127, stdout: '', stderr: `unexpected command: ${command}` };
  };
}

/** Mock provider replaying a fixed JSON script, remembering every request. */
function scriptedProvider(replies: string[]) {
  const messageLogs: string[][] = [];
  const options: unknown[] = [];
  let index = 0;
  const provider = {
    async chat(messages: Array<{ role: string; content: string }>, opts?: unknown) {
      messageLogs.push(messages.map((message) => message.content));
      options.push(opts);
      const content = replies[index] ?? '{"final":"（脚本已用尽）"}';
      index += 1;
      return { content };
    },
  };
  return {
    messageLogs,
    options,
    getProvider: () => provider,
    calls: () => index,
  };
}

function envFor(overrides: Partial<OperatorEnv> = {}): OperatorEnv {
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

function drive(
  goal: string,
  provider: ReturnType<typeof scriptedProvider>,
  env: OperatorEnv,
  store: ReturnType<typeof storage>,
): Promise<string> {
  return runAgent(
    goal,
    env,
    provider.getProvider,
    operatorTools,
    store.iface,
    env.logger,
    { pendingTtlSeconds: 300_000 },
  );
}

describe('operator agent loop (e2e)', () => {
  it('diagnoses a dirty worktree over a multi-step ReAct loop', async () => {
    const store = storage();
    const execCalls: string[][] = [];
    const env = envFor({ storage: store.iface, exec: fakeExec(execCalls) });
    const provider = scriptedProvider([
      '{"tool":"git","args":["status"]}',
      '{"tool":"diag","args":["health"]}',
      '{"final":"诊断完成：工作树有未提交改动"}',
    ]);

    const reply = await drive('为什么工作树是脏的？', provider, env, store);

    // final answer + per-step summary
    expect(reply).toContain('诊断完成：工作树有未提交改动');
    expect(reply).toContain('—— agent 步骤 ——');
    expect(reply).toContain('[1] git(status) -> ok');
    expect(reply).toContain('[2] diag(health) -> ok');

    // first call: system prompt advertises the tools, options are the admin task
    expect(provider.messageLogs[0]![0]).toContain('- git [read] ?op git');
    expect(provider.messageLogs[0]![0]).toContain('- verify [write] ?op verify');
    expect(provider.options[0]).toMatchObject({ task: 'admin', temperature: 0.2 });

    // read tools ran for real through the injected exec…
    expect(execCalls).toContainEqual(['git', '-C', '/repo', 'status', '--porcelain=v1', '--branch']);
    // …and their outputs came back as observations for the next model turn
    expect(provider.messageLogs[1]!.join('\n')).toContain(' M plugins/operator/index.ts');
    expect(provider.messageLogs[2]!.join('\n')).toContain('诊断：健康检查');

    // three model turns, stopped by `final` rather than the step cap
    expect(provider.calls()).toBe(3);

    // audit trail: one entry per tool run plus the agent summary entry
    expect(store.store.has('audit')).toBe(true);
    const entries = await readAudit(store.iface);
    expect(entries.filter((entry) => entry.detail === 'agent').map((entry) => entry.tool))
      .toEqual(['git', 'diag']);
    expect(entries.find((entry) => entry.tool === 'agent')).toMatchObject({
      args: '为什么工作树是脏的？',
      caller: 'admin-1',
      outcome: 'ok',
      detail: 'steps=2',
    });
  });

  it('stages a write tool instead of executing it and asks for ?op confirm', async () => {
    const store = storage();
    const execCalls: string[][] = [];
    const env = envFor({ storage: store.iface, exec: fakeExec(execCalls) });
    const provider = scriptedProvider(['{"tool":"verify","args":["typecheck"]}']);

    const reply = await drive('跑一遍类型检查', provider, env, store);

    // loop stops after a single turn: a write proposal awaits a human
    expect(provider.calls()).toBe(1);
    expect(reply).toContain('agent 提议执行 verify');
    expect(execCalls.some((call) => call[0] === 'npm')).toBe(false);

    // staged pending is caller-bound and its nonce is what the reply hands out
    const pending = await store.iface.get<{ nonce: string; tool: string; args: string[]; caller: string }>('pending');
    expect(pending).toMatchObject({ tool: 'verify', args: ['typecheck'], caller: 'admin-1' });
    expect(reply).toContain(`?op confirm ${pending!.nonce}`);

    const entries = await readAudit(store.iface);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ tool: 'verify', args: 'typecheck', outcome: 'staged', detail: 'agent' });
  });

  it('feeds an unknown-tool refusal back as an observation and keeps going', async () => {
    const store = storage();
    const env = envFor({ storage: store.iface });
    const provider = scriptedProvider([
      '{"tool":"deploy","args":[]}',
      '{"final":"部署工具不存在，改用其他方式"}',
    ]);

    const reply = await drive('部署服务', provider, env, store);

    expect(reply).toContain('部署工具不存在，改用其他方式');
    expect(reply).toContain('[1] deploy -> 工具不存在：deploy');
    expect(provider.messageLogs[1]).toContain('工具执行结果：工具不存在：deploy');

    const entries = await readAudit(store.iface);
    expect(entries.find((entry) => entry.tool === 'agent')).toMatchObject({ outcome: 'ok', detail: 'steps=1' });
  });
});
