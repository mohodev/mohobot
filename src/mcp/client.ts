/**
 * Minimal MCP client: `initialize` -> `tools/list` -> `tools/call`.
 *
 * The security-relevant part lives in `callTool`: every invocation passes the
 * pure permission gate (src/mcp/permissions.ts) and is written to the bounded
 * audit log (src/mcp/audit.ts) BEFORE the transport is touched, so a denied
 * call never reaches the server and no call - allowed, denied or failed -
 * goes unrecorded. Transport faults never escape raw: they surface as typed
 * `McpError`s (or as `isError` results for tool-level failures).
 */

import type { Logger } from '../core/logger.js';
import { McpAuditLog, redactArgs } from './audit.js';
import { McpToolPolicy, defaultPolicy } from './permissions.js';
import {
  McpError,
  isTextContent,
  type McpCallResult,
  type McpCaller,
  type McpContent,
  type McpTool,
  type McpTransport,
} from './types.js';

/** Protocol version advertised in the handshake (MCP spec revision). */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

export interface McpClientOptions {
  /** Tool permission policy; defaults to `defaultPolicy` (fail closed). */
  policy?: McpToolPolicy;
  /** Audit sink; defaults to a fresh in-memory log with the standard cap. */
  audit?: McpAuditLog;
  /** Identity advertised to the server during `initialize`. */
  clientInfo?: { name: string; version: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeContent(raw: unknown): McpContent {
  if (isRecord(raw) && typeof raw['type'] === 'string') {
    const { type, ...rest } = raw;
    if (type === 'text') return { type: 'text', text: typeof rest['text'] === 'string' ? rest['text'] : '' };
    return { type, ...rest };
  }
  return { type: 'text', text: String(raw) };
}

function normalizeCallResult(raw: unknown, tool: string): McpCallResult {
  if (!isRecord(raw) || !Array.isArray(raw['content'])) {
    throw new McpError('protocol', `tools/call for '${tool}' returned a malformed result`, { tool });
  }
  const content = raw['content'].map(normalizeContent);
  return raw['isError'] === true ? { content, isError: true } : { content };
}

function firstText(content: readonly McpContent[]): string | undefined {
  return content.find(isTextContent)?.text;
}

export class McpClient {
  readonly #transport: McpTransport;
  readonly #logger: Logger | undefined;
  readonly #policy: McpToolPolicy;
  readonly #audit: McpAuditLog;
  readonly #clientInfo: { name: string; version: string };
  #serverInfo: { name: string; version: string } | undefined;
  #initialized = false;

  constructor(transport: McpTransport, logger?: Logger, options: McpClientOptions = {}) {
    this.#transport = transport;
    this.#logger = logger;
    this.#policy = options.policy ?? defaultPolicy;
    this.#audit = options.audit ?? new McpAuditLog();
    this.#clientInfo = options.clientInfo ?? { name: 'mohobot', version: '1.0.0' };
  }

  get initialized(): boolean { return this.#initialized; }
  get serverInfo(): { name: string; version: string } | undefined { return this.#serverInfo; }
  get auditLog(): McpAuditLog { return this.#audit; }
  get policy(): McpToolPolicy { return this.#policy; }

  /** JSON-RPC handshake. Idempotent; failures surface as typed McpErrors. */
  async initialize(): Promise<void> {
    if (this.#initialized) return;
    let raw: unknown;
    try {
      raw = await this.#transport.send('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: this.#clientInfo,
      });
    } catch (error) {
      throw new McpError('transport', `mcp initialize failed: ${errorMessage(error)}`, { cause: error });
    }
    if (!isRecord(raw)) throw new McpError('protocol', 'mcp initialize returned a malformed result');
    const info = raw['serverInfo'];
    this.#serverInfo = isRecord(info)
      ? { name: String(info['name'] ?? 'unknown'), version: String(info['version'] ?? 'unknown') }
      : undefined;
    this.#initialized = true;
    // Handshake-complete notification; a transport that rejects it is tolerated.
    try {
      await this.#transport.send('notifications/initialized');
    } catch (error) {
      this.#logger?.warn({ err: errorMessage(error) }, 'mcp initialized notification failed');
    }
  }

  async listTools(): Promise<McpTool[]> {
    if (!this.#initialized) throw new McpError('protocol', 'mcp client is not initialized');
    let raw: unknown;
    try {
      raw = await this.#transport.send('tools/list', {});
    } catch (error) {
      throw new McpError('transport', `mcp tools/list failed: ${errorMessage(error)}`, { cause: error });
    }
    if (!isRecord(raw) || !Array.isArray(raw['tools'])) {
      throw new McpError('protocol', 'mcp tools/list returned a malformed result');
    }
    const tools: McpTool[] = [];
    for (const item of raw['tools']) {
      if (!isRecord(item) || typeof item['name'] !== 'string' || item['name'].length === 0) continue;
      const tool: McpTool = { name: item['name'] };
      if (typeof item['description'] === 'string') tool.description = item['description'];
      if (isRecord(item['inputSchema'])) tool.inputSchema = item['inputSchema'];
      tools.push(tool);
    }
    return tools;
  }

  /**
   * Permission-gated, audited tool invocation. Denials throw before the
   * transport is touched; tool-level failures come back as `isError` results;
   * transport/protocol faults throw typed McpErrors. Every path is recorded.
   *
   * TODO: When MCP results are consumed outside the LLM tool-call loop
   * (e.g. admin UI, ACP), apply `markUntrusted('mcp', …)` +
   * `formatUntrustedData()` at that surface before injecting into any prompt.
   * The chat-tool path already wraps via `executeToolCall` (source: 'tool').
   */
  async callTool(name: string, args: Record<string, unknown> | undefined, caller: McpCaller): Promise<McpCallResult> {
    const label = caller ? `${caller.id ?? 'anonymous'} (${caller.role ?? 'unknown'})` : 'anonymous';
    const argsRedacted = redactArgs(args);
    const decision = this.#policy.authorize(name, caller);
    if (!decision.allow) {
      this.#audit.record({ tool: name, caller: label, outcome: 'denied', detail: decision.reason, argsRedacted });
      this.#logger?.warn({ tool: name, caller: caller?.id, reason: decision.reason }, 'mcp tool call denied');
      throw new McpError('denied', decision.reason, { tool: name });
    }
    try {
      if (!this.#initialized) {
        throw new McpError('protocol', `mcp client is not initialized; cannot call '${name}'`, { tool: name });
      }
      const raw = await this.#transport.send('tools/call', { name, arguments: args ?? {} });
      const result = normalizeCallResult(raw, name);
      if (result.isError) {
        this.#audit.record({ tool: name, caller: label, outcome: 'error', detail: firstText(result.content) ?? 'tool returned isError', argsRedacted });
      } else {
        this.#audit.record({ tool: name, caller: label, outcome: 'allowed', detail: 'ok', argsRedacted });
      }
      return result;
    } catch (error) {
      const failure = error instanceof McpError
        ? error
        : new McpError('transport', `mcp transport failed calling '${name}': ${errorMessage(error)}`, { tool: name, cause: error });
      this.#audit.record({ tool: name, caller: label, outcome: 'error', detail: failure.message, argsRedacted });
      this.#logger?.warn({ tool: name, err: failure.message }, 'mcp tool call failed');
      throw failure;
    }
  }
}
