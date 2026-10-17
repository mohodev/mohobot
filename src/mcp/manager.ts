/**
 * Config-driven MCP multi-server manager.
 *
 * Owns exactly one `McpClient` per configured server, chosen by the
 * `transport` field (`stdio` command or `http` url). Every client shares ONE
 * `McpAuditLog`, so the merged call history is the manager's `audit()` and a
 * denied call is visible no matter which server it targeted.
 *
 * Failure isolation is the point: a server that cannot be spawned, handshaked
 * or listed never throws out of `start()` - it is recorded in that server's
 * `McpServerStatus.error` and every other server keeps working.
 *
 * The real Stdio/Http transports are built by a small factory seam so tests
 * can inject an in-memory fake (`transportFactory`).
 */

import type { Logger } from '../core/logger.js';
import { McpAuditLog, type McpAuditEntry } from './audit.js';
import { McpClient } from './client.js';
import { McpToolPolicy, defaultPolicy, type McpToolRule } from './permissions.js';
import { HttpTransport, StdioTransport } from './transport.js';
import {
  McpError,
  type McpCallResult,
  type McpCaller,
  type McpTool,
  type McpTransport,
} from './types.js';

export interface McpServerConfig {
  id: string;
  enabled?: boolean;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** Per-server tool rules; omitted means `defaultPolicy` (fail closed). */
  policy?: McpToolRule[];
}

export interface McpServerStatus {
  id: string;
  transport: string;
  initialized: boolean;
  toolCount: number;
  error?: string;
}

/** A tool as exposed by the manager: which server owns it and what it is called. */
export interface McpToolRef {
  server: string;
  name: string;
  description?: string;
}

/** Builds the transport for one server; overridable for tests. */
export type McpTransportFactory = (config: McpServerConfig) => McpTransport;

export interface McpManagerOptions {
  servers: McpServerConfig[];
  logger: Logger;
  /** Shared audit sink; defaults to a fresh in-memory log with `auditCap`. */
  audit?: McpAuditLog;
  auditCap?: number;
  /** Test seam: replaces the real Stdio/Http transports. */
  transportFactory?: McpTransportFactory;
}

interface ServerEntry {
  config: McpServerConfig;
  status: McpServerStatus;
  client?: McpClient;
  transport?: McpTransport;
  tools: McpTool[];
}

/** The optional teardown the concrete transports (and test fakes) may carry. */
interface Closable {
  close?: () => void | Promise<void>;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function closeTransport(transport: McpTransport | undefined): Promise<void> {
  const close = (transport as Closable | undefined)?.close;
  if (typeof close !== 'function') return;
  try {
    await close.call(transport);
  } catch {
    /* best effort: closing must never fail a stop() or a failed start() */
  }
}

export class McpManager {
  readonly #entries = new Map<string, ServerEntry>();
  readonly #logger: Logger;
  readonly #audit: McpAuditLog;
  readonly #factory: McpTransportFactory;
  #startPromise: Promise<void> | undefined;

  constructor(options: McpManagerOptions) {
    this.#logger = options.logger;
    this.#audit = options.audit ?? new McpAuditLog(options.auditCap);
    this.#factory = options.transportFactory ?? ((config) => this.#buildTransport(config));
    const servers = Array.isArray(options.servers) ? options.servers : [];
    for (const config of servers) {
      const id = typeof config?.id === 'string' ? config.id : '';
      if (id.length === 0) {
        this.#logger.warn({ transport: config?.transport }, 'mcp manager: skipping server without an id');
        continue;
      }
      if (this.#entries.has(id)) {
        this.#logger.warn({ server: id }, 'mcp manager: duplicate server id (keeping the last config)');
      }
      this.#entries.set(id, {
        config,
        status: { id, transport: config.transport, initialized: false, toolCount: 0 },
        tools: [],
      });
    }
  }

  /** Number of servers that are not explicitly disabled. */
  get enabledServers(): number {
    let count = 0;
    for (const entry of this.#entries.values()) if (entry.config.enabled !== false) count += 1;
    return count;
  }

  /**
   * Initialize every enabled server and cache its tools. Idempotent (including
   * concurrent calls) and never rejects: a broken server is captured in its
   * status while the rest proceed.
   */
  start(): Promise<void> {
    this.#startPromise ??= this.#runStart();
    return this.#startPromise;
  }

  status(): McpServerStatus[] {
    return [...this.#entries.values()].map((entry) => ({ ...entry.status }));
  }

  /** Every cached tool, flattened across servers and deduped by server+name. */
  tools(): McpToolRef[] {
    const seen = new Set<string>();
    const refs: McpToolRef[] = [];
    for (const entry of this.#entries.values()) {
      for (const tool of entry.tools) {
        const key = `${entry.config.id}\u0000${tool.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const ref: McpToolRef = { server: entry.config.id, name: tool.name };
        if (tool.description !== undefined) ref.description = tool.description;
        refs.push(ref);
      }
    }
    return refs;
  }

  /**
   * Route a call to its server's client. The permission gate and the audit
   * record happen inside `McpClient.callTool`; an unknown, disabled or
   * failed-to-start server throws a typed `McpError` before anything runs.
   */
  async callTool(serverId: string, tool: string, args: Record<string, unknown> | undefined, caller: McpCaller): Promise<McpCallResult> {
    const entry = this.#entries.get(serverId);
    if (entry === undefined || entry.config.enabled === false || entry.client === undefined) {
      throw new McpError('tool', `mcp server '${serverId}' is not available`, { tool });
    }
    try {
      return await entry.client.callTool(tool, args, caller);
    } catch (error) {
      if (error instanceof McpError) throw error;
      throw new McpError('tool', `mcp call '${tool}' on server '${serverId}' failed: ${describe(error)}`, { tool, cause: error });
    }
  }

  /** Merged audit history (newest first) across every server client. */
  audit(): McpAuditEntry[] {
    return this.#audit.list();
  }

  /** Close every transport that exposes `close()`. */
  async stop(): Promise<void> {
    for (const entry of this.#entries.values()) {
      await closeTransport(entry.transport);
      entry.transport = undefined;
      entry.client = undefined;
      entry.tools = [];
      entry.status.initialized = false;
      entry.status.toolCount = 0;
    }
  }

  /** Default factory: real stdio/http transports, validated per config. */
  #buildTransport(config: McpServerConfig): McpTransport {
    if (config.transport === 'http') {
      const url = config.url;
      if (typeof url !== 'string' || url.trim().length === 0) {
        throw new Error(`mcp server '${config.id}' uses http but has no url`);
      }
      return new HttpTransport({ url, headers: config.headers });
    }
    if (config.transport === 'stdio') {
      const command = config.command;
      if (typeof command !== 'string' || command.trim().length === 0) {
        throw new Error(`mcp server '${config.id}' uses stdio but has no command`);
      }
      return new StdioTransport({ command, args: config.args, env: config.env, cwd: config.cwd, logger: this.#logger });
    }
    throw new Error(`mcp server '${config.id}' has unsupported transport '${String(config.transport)}'`);
  }

  async #runStart(): Promise<void> {
    for (const entry of this.#entries.values()) {
      if (entry.config.enabled === false) continue;
      let transport: McpTransport | undefined;
      try {
        transport = this.#factory(entry.config);
        const client = new McpClient(transport, this.#logger, {
          policy: entry.config.policy ? new McpToolPolicy(entry.config.policy) : defaultPolicy,
          audit: this.#audit,
        });
        await client.initialize();
        const tools = await client.listTools();
        entry.transport = transport;
        entry.client = client;
        entry.tools = tools;
        entry.status.initialized = true;
        entry.status.toolCount = tools.length;
        entry.status.error = undefined;
      } catch (error) {
        entry.status.initialized = false;
        entry.status.toolCount = 0;
        entry.status.error = describe(error);
        entry.tools = [];
        this.#logger.warn({ server: entry.config.id, err: entry.status.error }, 'mcp server failed to start');
        await closeTransport(transport);
      }
    }
  }
}