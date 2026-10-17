/**
 * Operator agent framework (plugin side).
 *
 * Provides `?op` admin commands over a registry of scoped tools. The plugin is
 * disabled by default - like devtools, an operator capability is opt-in.
 *
 *   ?op                      列出工具与风险等级
 *   ?op <tool> [参数]         执行只读工具，或为需确认的工具生成确认码
 *   ?op confirm <确认码>      确认并执行暂存的操作（单次、绑定调用者、限时）
 *   ?op audit [条数]          最近的调用记录（已脱敏）
 */

import type { Plugin, PluginCommand, CommandContext } from '../../src/plugins/types.js';
import type { ScopedStorage } from '../../src/storage/types.js';

import {
  audit as writeAudit,
  authorize,
  consume,
  describeTool,
  lookupTool,
  readAudit,
  redactArgs,
  stage,
  type AuditEntry,
  type OperatorEnv,
  type OperatorTool,
} from './registry.js';
import { operatorTools } from './tools.js';

interface OperatorSettings {
  rootDir: string;
  pendingTtlSeconds: number;
  auditCap: number;
}

function settings(config: Record<string, unknown>): OperatorSettings {
  const rootDir = typeof config['rootDir'] === 'string' && config['rootDir'].trim() ? config['rootDir'].trim() : '.';
  const ttl = Number(config['pendingTtlSeconds']);
  const cap = Number(config['auditCap']);
  return {
    rootDir,
    pendingTtlSeconds: Number.isFinite(ttl) && ttl > 0 ? ttl * 1000 : 300_000,
    auditCap: Number.isFinite(cap) && cap > 0 ? cap : 200,
  };
}

function envFor(command: CommandContext, storage: ScopedStorage, logger: OperatorEnv['logger'], rootDir: string, traces?: OperatorEnv['traces'], sessions?: OperatorEnv['sessions']): OperatorEnv {
  const { exec } = spawnAdapter();
  return {
    callerId: command.message.author.id,
    isAdmin: command.message.author.isBotManager === true,
    storage,
    logger,
    rootDir,
    traces,
    sessions,
    exec,
  };
}

/** Default exec: child_process with a hard kill after the deadline. */
function spawnAdapter(): {
  exec: OperatorEnv['exec'];
} {
  return {
    async exec(command, args, options) {
      const { spawn } = await import('node:child_process');
      const timeoutMs = options?.timeoutMs ?? 30_000;
      return new Promise((resolve) => {
        const child = spawn(command, args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
        }, timeoutMs);
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.on('error', (error: Error) => {
          clearTimeout(timer);
          resolve({ code: 127, stdout, stderr: String(error.message) });
        });
        child.on('close', (code: number | null) => {
          clearTimeout(timer);
          resolve({ code: code ?? -1, stdout, stderr });
        });
      });
    },
  };
}

const operator: Plugin = {
  name: 'operator',

  async onLoad(context) {
    const config = settings(context.config);
    context.logger.info({ tools: operatorTools.map((tool) => tool.name), rootDir: config.rootDir }, 'operator framework ready');

    const storage = context.storage;
    const logger = context.logger;
    const traces = context.pipeline?.traces;
    const sessions = context.sessions;

    const toolHelp = (): string => [
      '运维工具（仅管理员）',
      ...operatorTools.map(describeTool),
      '用法：?op <工具> [参数]｜?op confirm <确认码>｜?op audit [条数]',
    ].join('\n');

    const list: PluginCommand[] = [
      {
        name: 'op',
        description: 'Operator framework: scoped, audited maintenance tools.',
        async execute(command) {
          const args = command.args;
          if (args.length === 0) return toolHelp();

          const env = envFor(command, storage, logger, config.rootDir, traces, sessions);

          if (args[0] === 'audit') {
            const entries = await readAudit(storage);
            if (entries.length === 0) return '还没有运维调用记录。';
            const wanted = Number(args[1] ?? 10);
            const limit = Number.isFinite(wanted) && wanted > 0 ? Math.min(wanted, entries.length) : 10;
            return entries
              .slice(-limit)
              .map(formatAudit)
              .join('\n');
          }

          if (args[0] === 'confirm') {
            const code = args[1] ?? '';
            const claimed = await consume({ storage }, code.trim(), env.callerId, config.pendingTtlSeconds);
            if (!claimed.request) return claimed.error ?? '确认失败。';
            const tool = lookupTool(operatorTools, claimed.request.tool);
            if (!tool) return '该操作对应的工具已不存在，请重新发起。';
            const outcome = await runTool(tool, claimed.request.args, env);
            return outcome;
          }

          const tool = lookupTool(operatorTools, args[0]!);
          if (!tool) {
            return `未知工具：${args[0]}\n可用工具：${operatorTools.map((entry) => entry.name).join(' / ')}`;
          }
          const rest = args.slice(1);

          const decision = authorize(tool, env);
          await writeAudit(env, {
            ts: Date.now(),
            tool: tool.name,
            args: redactArgs(rest),
            caller: env.callerId,
            outcome: decision.kind === 'deny' ? 'denied' : decision.stagingRequired ? 'staged' : 'allowed',
            detail: decision.kind === 'deny' ? decision.reason : undefined,
          });

          if (decision.kind === 'deny') return decision.reason;

          if (decision.stagingRequired) {
            const code = await stage({ storage }, tool.name, rest, env.callerId);
            return `已暂存 ${tool.name}，请在 ${Math.round(config.pendingTtlSeconds / 1000)} 秒内用「?op confirm ${code}」确认执行。`;
          }

          return runTool(tool, rest, env);
        },
      },
    ];

    for (const command of list) context.registerCommand(command);
  },
};

async function runTool(tool: OperatorTool, args: readonly string[], env: OperatorEnv): Promise<string> {
  try {
    const outcome = await tool.run(args, env);
    await writeAudit(env, {
      ts: Date.now(),
      tool: tool.name,
      args: redactArgs(args),
      caller: env.callerId,
      outcome: outcome.ok ? 'ok' : 'failed',
    });
    return outcome.output;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    env.logger.error({ err: detail, tool: tool.name }, 'operator tool crashed (contained)');
    await writeAudit(env, {
      ts: Date.now(),
      tool: tool.name,
      args: redactArgs(args),
      caller: env.callerId,
      outcome: 'failed',
      detail,
    });
    return `工具执行异常（已容错）：${detail}`;
  }
}

function formatAudit(entry: AuditEntry): string {
  const time = new Date(entry.ts).toISOString().slice(11, 19);
  const args = entry.args.length > 60 ? `${entry.args.slice(0, 60)}…` : entry.args;
  return `${time} ${entry.outcome.padEnd(7)} ${entry.tool}${args ? ` ${args}` : ''}${entry.detail ? ` - ${entry.detail}` : ''}`;
}

export default operator;
