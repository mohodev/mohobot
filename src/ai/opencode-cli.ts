/**
 * OpenCode CLI provider.
 *
 * Drives the local `opencode` binary through `opencode run --format json`, so
 * MohoBot can use any model the signed-in OpenCode installation can reach -
 * including free models such as `opencode/ling-3.1-flash-free` - WITHOUT an
 * API key. Authentication stays entirely inside OpenCode's own credential
 * store; this provider never reads, logs or forwards it.
 *
 * Why a subprocess instead of the Zen HTTP API: the Zen endpoint needs an API
 * key, while the CLI already carries the session. Transport is one-shot:
 * every MohoBot call is one `opencode run` invocation that receives the whole
 * conversation as a single prompt and prints a JSON event stream back.
 *
 * Each one-shot run leaves a server-side session behind, so the provider
 * deletes it right after the call (`session delete`, best effort, ~0.2s).
 * Without that the operator's `opencode session list` would fill with one
 * junk entry per bot reply. Opt out with `options.sessionCleanup: false`.
 *
 * By default the invocation joins OpenCode's resident background service
 * (`opencode service`, idempotently ensured by the CLI itself) instead of
 * booting a private server: measured ~3-4s less per call. `options.standalone`
 * opts back into per-call isolation, and a service-transport failure retries
 * once with `--standalone` so a broken service can never take chat down.
 *
 * Hard rules honoured here (same contract as every provider):
 *  - only AIError escapes chat();
 *  - the child process is always killed on timeout/abort;
 *  - health() never throws.
 */

import { spawn } from 'node:child_process';
import type { AIConfig } from '../config/schema.js';
import type { Logger } from '../core/logger.js';
import type { ChatMessage } from '../core/types.js';
import { AIError, type AIProvider, type AIResponse, type ChatOptions } from './types.js';

export interface OpenCodeCliDeps {
  logger: Logger;
  botId?: string;
  /** Executable name or path. Defaults to `opencode`. */
  bin?: string;
  /** Injected spawn for tests - signature matches child_process.spawn. */
  spawnImpl?: typeof spawn;
}

/** Event shapes emitted by `opencode run --format json`. */
interface CliEvent {
  type?: unknown;
  part?: {
    type?: unknown;
    text?: unknown;
    tokens?: { input?: unknown; output?: unknown; reasoning?: unknown };
    cost?: unknown;
  };
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_PROMPT_CHARS = 100_000;
/** Best-effort `session delete` budget: never slow a turn for housekeeping. */
const SESSION_CLEANUP_TIMEOUT_MS = 10_000;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Only failures the background service itself can cause - retrying those with
 * `--standalone` helps. Model-side exits, timeouts and aborts never match, so
 * a fallback cannot mask them or double their wait.
 */
export function isServiceTransportError(error: unknown): boolean {
  if (!(error instanceof AIError) || error.kind === 'timeout' || error.kind === 'aborted') return false;
  return /managed service|service port|port \d+.*in use|server process exited|eaddrinuse|econnrefused/i.test(error.message);
}

/** Compress the message array into one prompt the CLI can consume. */
export function renderPrompt(messages: ChatMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    const content = message.content.trim();
    if (!content) continue;
    if (message.role === 'system') {
      lines.push(`<system>\n${content}\n</system>`);
      continue;
    }
    const speaker = message.name ?? (message.role === 'assistant' ? 'assistant' : 'user');
    lines.push(`${message.role === 'assistant' ? 'assistant' : speaker}: ${content}`);
  }
  // The model is expected to answer as the character; no extra instructions.
  const prompt = lines.join('\n\n');
  return prompt.length > MAX_PROMPT_CHARS ? prompt.slice(-MAX_PROMPT_CHARS) : prompt;
}

/** Pull the final assistant text out of the CLI's JSON event stream. */
export function extractText(stdout: string): string {
  let text = '';
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event: CliEvent;
    try {
      event = JSON.parse(trimmed) as CliEvent;
    } catch {
      continue;
    }
    if (event.type === 'text' && event.part?.type === 'text' && typeof event.part.text === 'string') {
      text += event.part.text;
    }
  }
  return text.trim();
}

/** Pull the server-side session id out of a `--format json` stream, if any. */
export function extractSessionId(stdout: string): string | null {
  const match = stdout.match(/"sessionID"\s*:\s*"(ses_[A-Za-z0-9_]+)"/);
  return match ? match[1]! : null;
}

/** Last step-finish token accounting, best effort. */
function extractUsage(stdout: string): { input?: number; output?: number } | undefined {
  let usage: { input?: number; output?: number } | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event: CliEvent;
    try {
      event = JSON.parse(trimmed) as CliEvent;
    } catch {
      continue;
    }
    const tokens = event.part?.tokens;
    if (event.type === 'step_finish' && tokens) {
      const input = typeof tokens.input === 'number' ? tokens.input : undefined;
      const output = typeof tokens.output === 'number' ? tokens.output : undefined;
      usage = { ...(input !== undefined ? { input } : {}), ...(output !== undefined ? { output } : {}) };
    }
  }
  return usage;
}

export class OpenCodeCliProvider implements AIProvider {
  readonly name = 'opencode-cli';
  readonly model: string;

  readonly #logger: Logger;
  readonly #bin: string;
  readonly #spawn: typeof spawn;
  readonly #timeoutMs: number;
  readonly #standalone: boolean;
  readonly #sessionCleanup: boolean;

  constructor(cfg: AIConfig, deps: OpenCodeCliDeps) {
    this.#logger = deps.logger;
    this.model = cfg.model;
    this.#bin = deps.bin ?? (typeof cfg.options['bin'] === 'string' ? cfg.options['bin'] : 'opencode');
    this.#spawn = deps.spawnImpl ?? spawn;
    // Default: reuse the resident `opencode service` (faster). Opt out with
    // `options.standalone: true` for a private server per call.
    this.#standalone = cfg.options['standalone'] === true;
    // Every one-shot `run` leaves a server-side session behind; delete it so
    // the operator's session list is not flooded. Opt out with
    // `options.sessionCleanup: false` when debugging the provider.
    this.#sessionCleanup = cfg.options['sessionCleanup'] !== false;
    const configuredTimeout = Number(cfg.options['timeoutMs']);
    this.#timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : (cfg.timeoutMs || DEFAULT_TIMEOUT_MS);
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<AIResponse> {
    const started = Date.now();
    if (options.signal?.aborted) {
      throw new AIError('request aborted by caller', { kind: 'aborted', retryable: false });
    }
    const prompt = renderPrompt(messages);
    if (!prompt) throw new AIError('empty prompt', { kind: 'bad_request', retryable: false });

    const model = options.model ?? this.model;
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;

    let stdout: string;
    try {
      stdout = await this.#run(this.#args(model, prompt, this.#standalone), timeoutMs, options.signal);
    } catch (error) {
      if (this.#standalone || !isServiceTransportError(error)) throw error;
      // Background service unreachable/corrupt: one isolated retry keeps chat alive.
      this.#logger.warn({ err: describe(error) }, 'opencode background service unusable; retrying with --standalone');
      stdout = await this.#run(this.#args(model, prompt, true), timeoutMs, options.signal);
    }
    const content = extractText(stdout);
    if (!content) {
      throw new AIError('opencode run produced no text output', { kind: 'server', retryable: true });
    }
    const usage = extractUsage(stdout);
    return {
      content,
      model,
      ms: Date.now() - started,
      ...(usage ? { usage: { ...usage, totalTokens: (usage.input ?? 0) + (usage.output ?? 0) } } : {}),
    };
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.#run(['--version'], 10_000, undefined);
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: describe(error) };
    }
  }

  /** One-shot invocation args; `standalone` swaps the shared service for a private server. */
  #args(model: string, prompt: string, standalone: boolean): string[] {
    return ['run', ...(standalone ? ['--standalone'] : []), '-m', model, '--format', 'json', '--', prompt];
  }

  /** Spawn one CLI invocation; resolve with stdout, reject with AIError. */
  #run(args: string[], timeoutMs: number, signal: AbortSignal | undefined): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        action();
      };

      let child: ReturnType<typeof spawn>;
      try {
        child = this.#spawn(this.#bin, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      } catch (error) {
        reject(new AIError(`failed to spawn ${this.#bin}: ${describe(error)}`, { kind: 'network', retryable: false, cause: error }));
        return;
      }

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));

      const onAbort = (): void => {
        child.kill('SIGKILL');
        finish(() => reject(new AIError('request aborted by caller', { kind: 'aborted', retryable: false })));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(() => reject(new AIError(`opencode run timed out after ${timeoutMs}ms`, { kind: 'timeout', retryable: true })));
      }, timeoutMs);
      timer.unref?.();

      child.once('error', (error: Error) => {
        finish(() => reject(new AIError(`${this.#bin} failed: ${error.message}`, { kind: 'network', retryable: false, cause: error })));
      });
      child.once('close', (code) => {
        const out = Buffer.concat(stdout).toString('utf8');
        const err = Buffer.concat(stderr).toString('utf8');
        // Server-side sessions outlive the child on every path (success,
        // failure, timeout kill, abort kill): remove ours before settling so
        // one chat turn never leaves one session behind. Best effort only.
        void this.#cleanupSession(out).finally(() => {
          if (code === 0) {
            finish(() => resolve(out));
            return;
          }
          this.#logger.warn({ code, stderr: err.slice(0, 300) }, 'opencode run exited non-zero');
          finish(() => reject(new AIError(`opencode run exited ${code}: ${err.trim().slice(0, 200) || 'no stderr'}`, {
            kind: code === null ? 'aborted' : 'server',
            retryable: code !== null,
          })));
        });
      });
    });
  }

  /**
   * Deletes the server-side session a `run` left behind. Resolves in all
   * cases (missing id, spawn failure, non-zero exit, timeout): housekeeping
   * must never fail the turn that triggered it.
   */
  async #cleanupSession(stdout: string): Promise<void> {
    if (!this.#sessionCleanup) return;
    const sessionId = extractSessionId(stdout);
    if (!sessionId) return;
    await new Promise<void>((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = this.#spawn(this.#bin, ['session', 'delete', sessionId], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      } catch {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        resolve();
      }, SESSION_CLEANUP_TIMEOUT_MS);
      timer.unref?.();
      child.once('error', () => { clearTimeout(timer); resolve(); });
      child.once('close', () => { clearTimeout(timer); resolve(); });
    }).catch(() => {});
  }
}
