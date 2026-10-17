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
import { createSpawnExec } from '../../src/operator/exec.js';

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
} from '../../src/operator/registry.js';
import { operatorTools } from '../../src/operator/tools.js';

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
  return {
    callerId: command.message.author.id,
    isAdmin: command.message.author.isBotManager === true,
    storage,
    logger,
    rootDir,
    traces,
    sessions,
    exec: createSpawnExec(),
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
    const getProvider = context.getProvider;

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

          if (args[0] === 'agent') {
            const goal = args.slice(1).join(' ').trim();
            if (!goal) return '用法：?op agent <目标>';
            return runAgent(goal, env, getProvider, operatorTools, storage, logger, config);
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


export async function runAgent(
  goal: string,
  env: OperatorEnv,
  getProvider: OperatorEnv extends { getProvider?: infer G } ? G : any,
  tools: typeof operatorTools,
  storage: ScopedStorage,
  logger: OperatorEnv['logger'],
  config: { pendingTtlSeconds: number },
): Promise<string> {
  const provider = typeof getProvider === 'function' ? getProvider() : undefined;
  if (!provider) return 'AI provider 不可用，无法启动 agent。';

  const toolLines = tools.map((t) => `- ${t.name} [${t.risk}] ${t.usage} — ${t.description}`).join('\n');
  const system = [
    '你是 MohoBot 的运维 agent。你只能通过调用已列出的工具完成目标。',
    '可用工具：',
    toolLines,
    '每一轮你必须只输出一个 JSON 对象，不要输出其它文本：',
    '{"tool":"工具名","args":["参数..."]}  或  {"final":"给用户的最终回复"}',
    '写操作（risk=write）工具会被暂存并要求人工确认，你只能提议一次然后停止等待。',
    '不要编造工具或参数；不要把密钥写入任何内容。',
  ].join('\n');

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: system },
    { role: 'user', content: goal },
  ];

  const steps: string[] = [];
  const MAX_STEPS = 8;
  for (let i = 0; i < MAX_STEPS; i += 1) {
    let reply;
    try {
      reply = await provider.chat(messages as any, { task: 'admin', temperature: 0.2 });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return `agent 模型调用失败：${detail}\n步骤：\n${steps.join('\n')}`;
    }
    const text = (reply.content ?? '').trim();
    messages.push({ role: 'assistant', content: text });

    // extract JSON
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return `agent 输出无法解析为 JSON：${text}\n步骤：\n${steps.join('\n')}`;
    }
    let action: any;
    try {
      action = JSON.parse(match[0]);
    } catch {
      return `agent JSON 解析失败：${match[0]}\n步骤：\n${steps.join('\n')}`;
    }

    if (action && typeof action.final === 'string') {
      await writeAudit(env, { ts: Date.now(), tool: 'agent', args: goal, caller: env.callerId, outcome: 'ok', detail: `steps=${steps.length}` });
      return `${action.final}\n\n—— agent 步骤 ——\n${steps.join('\n') || '（无）'}`;
    }

    const toolName = String(action?.tool ?? '');
    const toolArgs: string[] = Array.isArray(action?.args) ? action.args.map((x: unknown) => String(x)) : [];
    const tool = tools.find((t) => t.name === toolName);
    if (!tool) {
      const obs = `工具不存在：${toolName}`;
      steps.push(`[${i + 1}] ${toolName} -> ${obs}`);
      messages.push({ role: 'user', content: `工具执行结果：${obs}` });
      continue;
    }

    const decision = authorize(tool, env);
    if (decision.kind === 'deny') {
      const obs = `拒绝：${decision.reason}`;
      steps.push(`[${i + 1}] ${toolName} -> ${obs}`);
      messages.push({ role: 'user', content: `工具执行结果：${obs}` });
      continue;
    }

    if (decision.stagingRequired) {
      const code = await stage({ storage }, tool.name, toolArgs, env.callerId);
      await writeAudit(env, { ts: Date.now(), tool: tool.name, args: redactArgs(toolArgs), caller: env.callerId, outcome: 'staged', detail: 'agent' });
      return `agent 提议执行 ${tool.name}，已暂存。请在 ${Math.round(config.pendingTtlSeconds / 1000)} 秒内用「?op confirm ${code}」确认。\n步骤：\n${steps.join('\n') || '（无）'}`;
    }

    const outcome = await tool.run(toolArgs, env as any);
    const obs = outcome.output;
    steps.push(`[${i + 1}] ${toolName}(${toolArgs.join(' ')}) -> ${outcome.ok ? 'ok' : 'failed'}`);
    await writeAudit(env, { ts: Date.now(), tool: tool.name, args: redactArgs(toolArgs), caller: env.callerId, outcome: outcome.ok ? 'ok' : 'failed', detail: 'agent' });
    messages.push({ role: 'user', content: `工具执行结果：${obs}` });
  }

  await writeAudit(env, { ts: Date.now(), tool: 'agent', args: goal, caller: env.callerId, outcome: 'failed', detail: 'max steps' });
  return `agent 达到最大步数（${MAX_STEPS}），停止。\n步骤：\n${steps.join('\n')}`;
}

export default operator;
