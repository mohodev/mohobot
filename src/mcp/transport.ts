/**
 * Real MCP transports: newline-delimited JSON-RPC over stdio and JSON-RPC
 * over HTTP.
 *
 * Both implement the `McpTransport` seam from ./types.ts and stay
 * dependency-free (node builtins only). They throw plain `Error`s on transport
 * faults; `McpClient` is what turns those into typed `McpError`s, so the
 * permission gate and the audit log stay in one place (src/mcp/client.ts).
 *
 * Framing: one JSON object per line (`\n`), a request matched to its pending
 * entry by numeric id. A notification (a method under `notifications/`)
 * carries no id and resolves as soon as it has been written/read, because the
 * protocol defines no response for it.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { Logger } from '../core/logger.js';
import type { McpTransport } from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveTimeout(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_TIMEOUT_MS;
}

/** JSON-RPC notifications never get a response and carry no request id. */
function isNotification(method: string): boolean {
  return method.startsWith('notifications/');
}

export interface StdioTransportOptions {
  /** Executable to spawn, e.g. `node` or an `mcp-server-*` binary. */
  command: string;
  args?: string[];
  /** Extra environment variables, merged over `process.env`. */
  env?: Record<string, string>;
  cwd?: string;
  /** Per-request deadline; defaults to 30000ms. */
  timeoutMs?: number;
  /** stderr is drained here; it is never thrown or mixed into stdout. */
  logger?: Logger;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Spawns a long-lived child process and speaks line-delimited JSON-RPC 2.0 on
 * its stdio pipes. One request at a time per call, matched by id; a hung
 * server is bounded by `timeoutMs` and a dead child fails every pending call
 * instead of leaking them.
 */
export class StdioTransport implements McpTransport {
  readonly #command: string;
  readonly #args: string[];
  readonly #env: Record<string, string> | undefined;
  readonly #cwd: string | undefined;
  readonly #timeoutMs: number;
  readonly #logger: Logger | undefined;

  #child: ChildProcess | undefined;
  #childExited = true;
  #closed = false;
  #nextId = 1;
  #buffer = '';
  readonly #pending = new Map<number, PendingRequest>();

  constructor(options: StdioTransportOptions) {
    const command = options?.command;
    if (typeof command !== 'string' || command.trim().length === 0 || command.includes('\0')) {
      throw new Error('stdio mcp transport requires a non-empty command without NUL bytes');
    }
    const args = options.args ?? [];
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
      throw new Error('stdio mcp transport args must be an array of strings');
    }
    this.#command = command;
    this.#args = [...args];
    this.#env = options.env;
    this.#cwd = options.cwd;
    this.#timeoutMs = resolveTimeout(options.timeoutMs);
    this.#logger = options.logger;
  }

  send(method: string, params?: unknown): Promise<unknown> {
    const name = typeof method === 'string' ? method.trim() : '';
    if (name.length === 0) return Promise.reject(new Error('mcp method must be a non-empty string'));
    if (this.#closed) return Promise.reject(new Error('stdio mcp transport is closed'));

    const notification = isNotification(name);
    const payload: Record<string, unknown> = { jsonrpc: '2.0', method: name };
    if (params !== undefined) payload['params'] = params;

    try {
      this.#ensureChild();
    } catch (error) {
      return Promise.reject(new Error(`failed to spawn stdio mcp process: ${describe(error)}`));
    }

    if (notification) {
      try {
        this.#write(payload);
      } catch (error) {
        return Promise.reject(error);
      }
      return Promise.resolve(undefined);
    }

    const id = this.#nextId++;
    payload['id'] = id;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`stdio mcp request '${name}' timed out after ${this.#timeoutMs}ms`));
      }, this.#timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#write(payload);
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(describe(error)));
      }
    });
  }

  /** Kill the child and fail anything still in flight. Safe to call twice. */
  async close(): Promise<void> {
    this.#closed = true;
    const child = this.#child;
    const alreadyExited = this.#childExited;
    this.#child = undefined;
    this.#childExited = true;
    this.#buffer = '';
    this.#failAll(new Error('stdio mcp transport closed'));
    if (!child) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, 2000);
      timer.unref?.();
      child.once('exit', done);
      child.once('error', done);
      child.once('close', done);
      try {
        child.kill('SIGKILL');
      } catch {
        done();
      }
      // A child that already exited will not emit again; do not wait for the wall clock.
      if (alreadyExited) done();
    });
  }

  #ensureChild(): void {
    if (this.#child !== undefined && !this.#childExited) return;
    this.#spawnChild();
  }

  #spawnChild(): void {
    const child = spawn(this.#command, this.#args, {
      cwd: this.#cwd,
      env: { ...process.env, ...(this.#env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    this.#child = child;
    this.#childExited = false;
    this.#buffer = '';

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.#onStdout(chunk));
    child.stdout?.on('error', (error: Error) => this.#failAll(new Error(`stdio mcp stdout error: ${error.message}`)));
    // stderr belongs to the server's diagnostics: drain it to the log, never to
    // the protocol stream, and never let it fail a call.
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      const text = chunk.trim();
      if (text.length > 0) this.#logger?.debug({ cmd: this.#command, stderr: text.slice(0, 300) }, 'mcp stdio stderr');
    });
    child.stderr?.on('error', () => { /* diagnostics only */ });
    child.stdin?.on('error', (error: Error) => this.#failAll(new Error(`stdio mcp stdin error: ${error.message}`)));

    child.on('error', (error: Error) => {
      this.#childExited = true;
      this.#failAll(new Error(`stdio mcp process error: ${error.message}`));
    });
    child.on('exit', (code, signal) => {
      this.#childExited = true;
      this.#failAll(new Error(`stdio mcp process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`));
    });
  }

  #write(payload: Record<string, unknown>): void {
    const child = this.#child;
    if (child === undefined || this.#childExited || child.stdin === null || child.stdin === undefined) {
      throw new Error('stdio mcp process is not running');
    }
    const line = `${JSON.stringify(payload)}\n`;
    try {
      child.stdin.write(line);
    } catch (error) {
      throw new Error(`failed to write to stdio mcp process: ${describe(error)}`);
    }
  }

  #onStdout(chunk: string): void {
    this.#buffer += chunk;
    let index = this.#buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.#buffer.slice(0, index).replace(/\r$/, '');
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.trim().length > 0) this.#onLine(line);
      index = this.#buffer.indexOf('\n');
    }
  }

  #onLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.#logger?.debug({ line: line.slice(0, 200) }, 'mcp stdio: ignoring non-JSON line');
      return;
    }
    if (!isRecord(message)) return;
    const id = message['id'];
    // Notifications and server-initiated requests are not something we await.
    if (typeof id !== 'number') return;
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    const error = message['error'];
    if (error !== undefined) {
      const text = isRecord(error) && typeof error['message'] === 'string'
        ? String(error['message'])
        : `stdio mcp server returned an error for id ${id}`;
      pending.reject(new Error(text));
      return;
    }
    pending.resolve(message['result']);
  }

  #failAll(error: Error): void {
    if (this.#pending.size === 0) return;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

export interface HttpTransportOptions {
  /** JSON-RPC endpoint; must be an http(s) URL. */
  url: string;
  headers?: Record<string, string>;
  /** Per-request deadline; defaults to 30000ms. */
  timeoutMs?: number;
}

/**
 * Posts JSON-RPC 2.0 bodies to an HTTP endpoint via global `fetch`. A timeout
 * is enforced with both an AbortController and a race, so a fetch that ignores
 * the signal (or a stubbed one) still cannot hang a call.
 */
export class HttpTransport implements McpTransport {
  readonly #url: string;
  readonly #headers: Record<string, string>;
  readonly #timeoutMs: number;
  #nextId = 1;

  constructor(options: HttpTransportOptions) {
    const raw = options?.url;
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new Error('http mcp transport requires a url');
    }
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error(`http mcp transport url is not a valid URL: ${raw}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`http mcp transport url must be http or https, got '${parsed.protocol}'`);
    }
    this.#url = parsed.toString();
    this.#headers = { ...(options.headers ?? {}) };
    this.#timeoutMs = resolveTimeout(options.timeoutMs);
  }

  async send(method: string, params?: unknown): Promise<unknown> {
    const name = typeof method === 'string' ? method.trim() : '';
    if (name.length === 0) throw new Error('mcp method must be a non-empty string');

    const notification = isNotification(name);
    const body: Record<string, unknown> = { jsonrpc: '2.0', method: name };
    if (!notification) body['id'] = this.#nextId++;
    if (params !== undefined) body['params'] = params;

    const response = await this.#post(body);
    if (notification) return undefined;

    const text = await response.text().catch(() => '');
    let payload: unknown;
    try {
      payload = text.length === 0 ? undefined : JSON.parse(text);
    } catch {
      throw new Error('http mcp server returned invalid JSON');
    }
    if (payload === undefined) return undefined;
    if (!isRecord(payload)) throw new Error('http mcp server returned a malformed JSON-RPC body');
    const error = payload['error'];
    if (error !== undefined) {
      const message = isRecord(error) && typeof error['message'] === 'string'
        ? String(error['message'])
        : 'http mcp server returned an error';
      throw new Error(message);
    }
    return payload['result'];
  }

  async #post(body: Record<string, unknown>): Promise<Response> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`http mcp request timed out after ${this.#timeoutMs}ms`));
      }, this.#timeoutMs);
      timer.unref?.();
    });

    let response: Response;
    try {
      response = await Promise.race([
        fetch(this.#url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', ...this.#headers },
          body: JSON.stringify(body),
          signal: controller.signal,
        }),
        timeout,
      ]);
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`http mcp request timed out after ${this.#timeoutMs}ms`);
      throw new Error(`http mcp request failed: ${describe(error)}`);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    if (response.ok === false || response.status >= 400) {
      throw new Error(`http mcp server returned ${response.status} ${response.statusText}`.trim());
    }
    return response;
  }
}