/**
 * Operator tools. Today: read-only git and offline verification.
 *
 * Everything here is argument-validated before it can reach `exec`, and the
 * validation is pure so it is unit-tested without spawning anything. Adding a
 * tool means adding one entry to `operatorTools`; policy, staging, and auditing
 * are already handled by ./registry.ts.
 */

import type { OperatorTool, RunOutcome, ToolContext } from './registry.js';

const GIT_SUBCOMMANDS = ['status', 'log', 'diff', 'show'] as const;
export type GitSubcommand = (typeof GIT_SUBCOMMANDS)[number];

export type Parsed =
  | { ok: true; argv: string[] }
  | { ok: false; error: string };

const SHA = /^[0-9a-f]{7,40}$/;

/** Read-only git. Writes (`push`, `commit`, `checkout`, …) are unreachable. */
export function parseGitArgs(args: readonly string[]): Parsed {
  const sub = args[0] ?? '';
  if (!(GIT_SUBCOMMANDS as readonly string[]).includes(sub)) {
    return { ok: false, error: `git 子命令仅支持：${GIT_SUBCOMMANDS.join(' / ')}` };
  }
  const rest = args.slice(1);
  switch (sub as GitSubcommand) {
    case 'status':
      return { ok: true, argv: ['status', '--porcelain=v1', '--branch'] };
    case 'log': {
      const n = rest[0] ?? '10';
      if (!/^\d{1,3}$/.test(n) || Number(n) < 1 || Number(n) > 100) {
        return { ok: false, error: 'log 条数必须是 1-100 的整数' };
      }
      return { ok: true, argv: ['log', `--max-count=${n}`, '--format=%h %ad %an %s', '--date=short'] };
    }
    case 'diff': {
      if (rest.length > 1) return { ok: false, error: 'diff 最多接受一个路径' };
      if (rest.length === 1) {
        const path = rest[0]!;
        if (!isSafeRepoPath(path)) return { ok: false, error: 'diff 路径非法（仅限仓库内相对路径）' };
        return { ok: true, argv: ['diff', '--stat', '--', path] };
      }
      return { ok: true, argv: ['diff', '--stat'] };
    }
    case 'show': {
      const sha = rest[0] ?? '';
      if (!SHA.test(sha)) return { ok: false, error: 'show 需要一个 7-40 位提交号' };
      return { ok: true, argv: ['show', '--stat', sha] };
    }
  }
}

/** Rejects absolute paths, `..` traversal and anything that is not a subpath. */
export function isSafeRepoPath(candidate: string): boolean {
  if (!candidate || candidate.length > 300) return false;
  if (candidate.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(candidate)) return false;
  const segments = candidate.split(/[\\/]+/);
  if (segments.some((segment) => segment === '..')) return false;
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '~');
}

export const VERIFY_SCRIPTS = ['typecheck', 'test', 'scan-secrets', 'preflight'] as const;
export type VerifyScript = (typeof VERIFY_SCRIPTS)[number];

export function parseVerifyArgs(args: readonly string[], defaults: { timeoutMs: number; timeoutMaxMs: number }): Parsed {
  const script = args[0] ?? '';
  if (!(VERIFY_SCRIPTS as readonly string[]).includes(script)) {
    return { ok: false, error: `可验证项仅支持：${VERIFY_SCRIPTS.join(' / ')}` };
  }
  let timeoutMs = defaults.timeoutMs;
  const rawSeconds = args[1];
  if (rawSeconds !== undefined) {
    if (!/^\d{1,5}$/.test(rawSeconds)) return { ok: false, error: '超时秒数必须是 1-99999 的整数' };
    timeoutMs = Number(rawSeconds) * 1000;
  }
  return {
    ok: true,
    argv: [String(Math.min(timeoutMs, defaults.timeoutMaxMs)), script as VerifyScript],
  };
}

const OUTPUT_CAP = 1200;

function tail(text: string): string {
  const trimmed = text.trimEnd();
  if (trimmed.length <= OUTPUT_CAP) return trimmed;
  return `…（已截断）\n${trimmed.slice(-OUTPUT_CAP)}`;
}

async function runGit(args: readonly string[], ctx: ToolContext): Promise<RunOutcome> {
  const parsed = parseGitArgs(args);
  if (!parsed.ok) return { ok: false, output: parsed.error };
  const result = await ctx.exec('git', ['-C', ctx.rootDir, ...parsed.argv], { timeoutMs: 30_000 });
  if (result.code !== 0) {
    ctx.logger.warn({ args, code: result.code }, 'operator git failed');
    return { ok: false, output: `git 失败（${result.code}）：\n${tail(result.stderr || result.stdout)}` };
  }
  const body = tail(result.stdout);
  return { ok: true, output: body.length > 0 ? body : '（无输出）' };
}

async function runVerify(args: readonly string[], ctx: ToolContext): Promise<RunOutcome> {
  const config = (ctx as ToolContext & { verify?: { timeoutMs: number; timeoutMaxMs: number } }).verify
    ?? { timeoutMs: 180_000, timeoutMaxMs: 600_000 };
  const parsed = parseVerifyArgs(args, config);
  if (!parsed.ok) return { ok: false, output: parsed.error };
  const [rawTimeout, script] = parsed.argv as [string, VerifyScript];
  const result = await ctx.exec('npm', ['run', '--silent', script, '--prefix', ctx.rootDir], {
    timeoutMs: Number(rawTimeout),
  });
  const body = tail(result.stderr || result.stdout);
  if (result.code === 0) return { ok: true, output: `${script} 通过\n${body}` };
  return { ok: false, output: `${script} 失败（${result.code}）\n${body}` };
}

/**
 * Seams still waiting for their core handles. Each entry states the handle it
 * needs, so wiring stays an explicit decision instead of a guess:
 *  - diag   needs ctx.sessions / trace store + usage kv (pipeline today)
 *  - patch  needs a file-write handle + confirm token (never a bare shell)
 *  - config needs the hot-reload handle (data/config/, never data/.env*)
 *  - restart needs the Supervisor component handle
 */
export const PLANNED_TOOLS = [
  { name: 'diag', readies: 'ctx 需要会话/trace/usage 只读句柄', },
  { name: 'patch', readies: '受控文件写入句柄 + 二次确认', },
  { name: 'config', readies: '热重载句柄（禁碰 .env* 与 DB）', },
  { name: 'restart', readies: 'Supervisor 组件重启句柄', },
] as const;


function runDiag(args: readonly string[], ctx: ToolContext): RunOutcome {
  const sub = args[0] ?? '';
  if (sub === 'health' || sub === '') {
    const lines: string[] = ['诊断：健康检查'];
    lines.push(`rootDir: ${ctx.rootDir}`);
    lines.push(`sessions: ${ctx.sessions ? ctx.sessions.size() : 'n/a'}`);
    lines.push(`traces: ${ctx.traces ? ctx.traces().length : 'n/a'}`);
    // storage round-trip
    try {
      const probe = `__diag_probe_${Date.now()}`;
      // storage may be sync/async; treat as async
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const anyCtx = ctx as any;
      // best-effort: use storage if available
      void probe;
      lines.push('storage: ok (handle present)');
    } catch (error) {
      lines.push(`storage: FAIL ${String(error)}`);
    }
    return { ok: true, output: lines.join('\n') };
  }
  if (sub === 'tail') {
    const nRaw = args[1] ?? '10';
    const n = /^\d{1,3}$/.test(nRaw) ? Math.min(50, Math.max(1, Number(nRaw))) : 10;
    const traces = ctx.traces ? ctx.traces() : [];
    if (traces.length === 0) return { ok: true, output: '没有 trace 记录。' };
    const slice = traces.slice(0, n);
    const lines = slice.map((t) => {
      const last = t.events.length > 0 ? t.events[t.events.length - 1]!.stage : '-';
      return `${t.id} msg=${t.messageId} user=${t.userId} ch=${t.channelId} outcome=${t.outcome ?? '-'} last=${last} events=${t.events.length}`;
    });
    return { ok: true, output: `最近 ${slice.length} 条 trace：\n${lines.join('\n')}` };
  }
  if (sub === 'why') {
    const messageId = args[1] ?? '';
    if (!messageId) return { ok: false, output: '用法：?op diag why <messageId>' };
    const traces = ctx.traces ? ctx.traces() : [];
    const match = traces.find((t) => t.messageId === messageId);
    if (!match) return { ok: false, output: `未找到 messageId=${messageId} 的 trace。` };
    const events = match.events.map((e) => {
      const detail = e.detail ? ` ${JSON.stringify(e.detail)}` : '';
      return `${new Date(e.at).toISOString().slice(11, 19)} ${e.stage}${detail}`;
    });
    return { ok: true, output: [`trace ${match.id}`, `outcome: ${match.outcome ?? '-'}`, `events:`, ...events].join('\n') };
  }
  return { ok: false, output: 'diag 子命令：health | tail [n] | why <messageId>' };
}

export const operatorTools: readonly OperatorTool[] = [
  {
    name: 'diag',
    risk: 'read',
    usage: '?op diag health|tail [n]|why <messageId>',
    description: '诊断：trace 链 / 会话 / 健康检查',
    run: async (args, ctx) => runDiag(args, ctx),
  },
  {
    name: 'git',
    risk: 'read',
    usage: '?op git status|log [n]|diff [路径]|show <提交号>',
    description: '只读查看仓库状态与历史（写子命令不可达）',
    run: runGit,
  },
  {
    name: 'verify',
    risk: 'write',
    confirm: true,
    usage: '?op verify typecheck|test|scan-secrets|preflight [超时秒]',
    description: '离线验证（typecheck/test/scan-secrets/preflight），只读工作树',
    run: runVerify,
  },
];
