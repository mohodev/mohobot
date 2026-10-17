/**
 * Operator framework core: tool registry, policy, audit trail, two-step confirm.
 *
 * Deliberately dependency-free (no child_process, no fs) so the security model
 * and its failure modes can be tested without real side effects. Concrete tools
 * live in ./tools.ts and receive an injected `exec`.
 *
 * Hard rules encoded here:
 *  - only admins may invoke any tool (defense in depth; the pipeline already
 *    gates `?`, but a plugin must never trust its caller);
 *  - `danger` tools are refused outright - destructive work belongs outside a
 *    chat-connected process;
 *  - `write` tools are staged first and re-authorized with a single-use nonce;
 *  - every attempt, allowed or not, is appended to a capped audit list.
 */

import { randomBytes } from 'node:crypto';

import type { Logger } from '../../src/core/logger.js';
import type { ScopedStorage } from '../../src/storage/types.js';

export type RiskLevel = 'read' | 'write' | 'danger';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ToolContext {
  callerId: string;
  isAdmin: boolean;
  storage: ScopedStorage;
  logger: Logger;
  rootDir: string;
  /** Injected so tests never spawn a real process. */
  exec(command: string, args: readonly string[], options?: { timeoutMs?: number }): Promise<ExecResult>;
}

export interface RunOutcome {
  ok: boolean;
  /** Human-readable reply body. Never includes secrets. */
  output: string;
}

export interface OperatorTool {
  readonly name: string;
  readonly risk: RiskLevel;
  readonly usage: string;
  readonly description: string;
  /** Staged + re-authorized with a nonce before it may run. */
  readonly confirm?: boolean;
  run(args: readonly string[], ctx: ToolContext): Promise<RunOutcome>;
}

export interface OperatorEnv {
  callerId: string;
  isAdmin: boolean;
  storage: ScopedStorage;
  logger: Logger;
  rootDir: string;
  exec: ToolContext['exec'];
}

export type Decision =
  | { kind: 'deny'; reason: string }
  | { kind: 'allow'; stagingRequired: boolean };

const AUDIT_KEY = 'audit';
const PENDING_KEY = 'pending';
const AUDIT_CAP = 200;
const MAX_ARG_CHARS = 400;

export interface AuditEntry {
  ts: number;
  tool: string;
  args: string;
  caller: string;
  outcome: 'allowed' | 'staged' | 'denied' | 'failed' | 'ok';
  detail?: string;
}

export interface PendingRequest {
  nonce: string;
  tool: string;
  args: string[];
  caller: string;
  createdAt: number;
}

/** Pure policy: what may this caller do with this tool? */
export function authorize(tool: OperatorTool, env: Pick<OperatorEnv, 'callerId' | 'isAdmin'>): Decision {
  if (!env.callerId) return { kind: 'deny', reason: '缺少调用者身份' };
  if (!env.isAdmin) return { kind: 'deny', reason: '仅管理员可调用运维工具' };
  if (tool.risk === 'danger') return { kind: 'deny', reason: '破坏性操作不在机器人内执行，请人工处理' };
  return { kind: 'allow', stagingRequired: tool.confirm === true };
}

/** Arguments are redacted before they land in the audit trail. */
export function redactArgs(args: readonly string[]): string {
  const joined = args.join(' ').trim();
  if (joined.length <= MAX_ARG_CHARS) return joined;
  return `${joined.slice(0, MAX_ARG_CHARS)}…`;
}

export async function audit(env: Pick<OperatorEnv, 'storage' | 'logger'>, entry: AuditEntry): Promise<void> {
  try {
    const list = (await env.storage.get<AuditEntry[]>(AUDIT_KEY)) ?? [];
    list.push(entry);
    if (list.length > AUDIT_CAP) list.splice(0, list.length - AUDIT_CAP);
    await env.storage.save(AUDIT_KEY, list);
  } catch (error) {
    env.logger?.warn({ err: String(error) }, 'operator audit write failed');
  }
}

export async function readAudit(storage: ScopedStorage): Promise<AuditEntry[]> {
  try {
    return (await storage.get<AuditEntry[]>(AUDIT_KEY)) ?? [];
  } catch {
    return [];
  }
}

function nonce(): string {
  return randomBytes(6).toString('hex');
}

/**
 * Stage a confirmed request. An earlier pending request from the same caller is
 * replaced, so a caller cannot accumulate live nonces across different tools.
 */
export async function stage(env: Pick<OperatorEnv, 'storage'>, tool: string, args: readonly string[], caller: string): Promise<string> {
  const fresh: PendingRequest = { nonce: nonce(), tool, args: [...args], caller, createdAt: Date.now() };
  await env.storage.save(PENDING_KEY, fresh);
  return fresh.nonce;
}

async function readPending(storage: ScopedStorage): Promise<PendingRequest | undefined> {
  try {
    return await storage.get<PendingRequest>(PENDING_KEY);
  } catch {
    return undefined;
  }
}

export interface ConsumeResult {
  request?: PendingRequest;
  error?: string;
}

/** Single-use, caller-bound, TTL-bound claim of a staged request. */
export async function consume(
  env: Pick<OperatorEnv, 'storage'>,
  code: string,
  caller: string,
  ttlMs: number,
  now: number = Date.now(),
): Promise<ConsumeResult> {
  const pending = await readPending(env.storage);
  if (!pending) return { error: '没有待确认的运维操作。先执行需要确认的命令' };
  if (pending.caller !== caller) return { error: '该确认码属于其他调用者' };
  if (pending.nonce !== code) return { error: '确认码无效' };
  if (!Number.isFinite(pending.createdAt) || now - pending.createdAt > ttlMs) {
    await env.storage.delete(PENDING_KEY);
    return { error: '确认已过期，请重新发起' };
  }
  await env.storage.delete(PENDING_KEY);
  return { request: pending };
}

/** Resolve a registered tool by name; lookup is exact and case-sensitive. */
export function lookupTool(tools: readonly OperatorTool[], name: string): OperatorTool | undefined {
  return tools.find((tool) => tool.name === name);
}

const RISK_LABEL: Record<RiskLevel, string> = { read: '只读', write: '需确认', danger: '拒绝' };

export function describeTool(tool: OperatorTool): string {
  return `?? ${tool.name} [${RISK_LABEL[tool.risk]}] ${tool.description}\n   用法：${tool.usage}`;
}
