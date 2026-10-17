/**
 * ACP-facing adapter for the operator tool registry.
 *
 * The ACP server is a standalone stdio process that never loads plugins, so
 * nothing here imports from `plugins/`. The host injects plain structural
 * `AcpOperatorTool[]` objects (the plugin registry satisfies them at the
 * wiring site), which keeps this module dependency-free and unit-testable.
 *
 * Risk policy for editor callers — the caller is treated as an admin dev tool,
 * but the risk ladder still applies, because a stateless stdio protocol has
 * nowhere to stage a pending-nonce confirmation:
 *   - `read`   runs directly;
 *   - `write`  is refused with a Chinese explanation (use the chat channel);
 *   - `danger` is refused outright, exactly as in chat.
 */

import type { Logger } from '../core/logger.js';

export type AcpRiskLevel = 'read' | 'write' | 'danger';

export interface AcpExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Same shape as the operator `ToolContext['exec']`, declared locally. */
export type AcpExec = (
  command: string,
  args: readonly string[],
  options?: { timeoutMs?: number },
) => Promise<AcpExecResult>;

/**
 * What ACP can supply: root, logger and an injected `exec`.
 * Structurally a subset of the operator `ToolContext` — `storage` / `traces` /
 * `sessions` are unavailable in a stdio process, so read tools must tolerate
 * their absence (the plugin tools already do).
 */
export interface AcpOperatorContext {
  rootDir: string;
  logger: Logger;
  exec: AcpExec;
}

/** Fully-built context handed to a tool run by `runAcpTool`. */
export interface AcpToolContext extends AcpOperatorContext {
  callerId: string;
  isAdmin: boolean;
}

export interface AcpRunOutcome {
  ok: boolean;
  output: string;
}

/** Structural mirror of the plugin `OperatorTool`. */
export interface AcpOperatorTool {
  readonly name: string;
  readonly risk: AcpRiskLevel;
  readonly usage: string;
  readonly description: string;
  readonly confirm?: boolean;
  run(args: readonly string[], ctx: AcpToolContext): AcpRunOutcome | Promise<AcpRunOutcome>;
}

export interface AcpToolDescriptor {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: {
      args: { type: 'array'; items: { type: 'string' }; description: string };
    };
    required: string[];
    additionalProperties: boolean;
  };
}

const RISK_LABEL: Record<AcpRiskLevel, string> = { read: '只读', write: '写入', danger: '危险' };

/** Cap so a runaway client cannot flood a tool with arguments. */
const MAX_ARGS = 64;

/** Resolve a registered tool by name; lookup is exact and case-sensitive. */
export function findAcpTool(tools: readonly AcpOperatorTool[], name: string): AcpOperatorTool | undefined {
  return tools.find((tool) => tool.name === name);
}

/**
 * ACP `tools/list` entries: name + description (risk label appended so editors
 * see up front which calls will be refused) + a JSON-schema-ish input schema
 * whose only parameter is the string-array `args` operator tools take.
 */
export function listAcpTools(tools: readonly AcpOperatorTool[]): AcpToolDescriptor[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: `${tool.description}（风险：${RISK_LABEL[tool.risk]}）`,
    inputSchema: {
      type: 'object',
      properties: {
        args: { type: 'array', items: { type: 'string' }, description: `用法：${tool.usage}` },
      },
      required: [],
      additionalProperties: false,
    },
  }));
}

/**
 * Coerce JSON-RPC `arguments` into the string array operator tools take.
 * Returns `undefined` when the value is not coercible (not an array).
 */
export function coerceAcpArgs(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return undefined;
  return raw.slice(0, MAX_ARGS).map((value) => {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    const json = JSON.stringify(value);
    return json === undefined ? '' : json;
  });
}

/**
 * Run one tool for an ACP caller and return the reply body.
 *
 * Always resolves to a human-readable string: refusals and tool failures are
 * explanations, never throws — only the server decides what is a JSON-RPC
 * error (it pre-checks the tool name with `findAcpTool`).
 */
export async function runAcpTool(
  tools: readonly AcpOperatorTool[],
  name: string,
  args: readonly string[],
  ctx: AcpOperatorContext,
): Promise<string> {
  const tool = findAcpTool(tools, name);
  if (!tool) {
    const known = tools.map((t) => t.name).join(', ');
    return known ? `未知工具：${name}（可用：${known}）` : `未知工具：${name}（当前未接入任何工具）`;
  }
  if (tool.risk === 'danger') {
    ctx.logger.warn({ tool: name }, 'ACP refused danger tool');
    return `已拒绝执行危险工具「${name}」：破坏性操作不在机器人内执行，请人工处理。`;
  }
  if (tool.risk === 'write') {
    ctx.logger.warn({ tool: name }, 'ACP refused write tool');
    return `已拒绝执行写入类工具「${name}」：ACP 是无状态 stdio 协议，无法完成二次确认（?op confirm）。请改用聊天通道执行：${tool.usage}`;
  }

  const toolCtx: AcpToolContext = {
    callerId: 'acp',
    isAdmin: true,
    rootDir: ctx.rootDir,
    logger: ctx.logger,
    exec: ctx.exec,
  };
  try {
    const outcome = await tool.run(args, toolCtx);
    return outcome.output;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.warn({ tool: name, err: message }, 'ACP tool call failed');
    return `工具执行失败：${message}`;
  }
}
