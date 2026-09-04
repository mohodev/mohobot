/**
 * Kilo AI gateway provider.
 *
 * Shipped as a PLUGIN: nothing under src/ is touched. index.ts registers the
 * factory into `ctx.registry.providers`, which is exactly the extension model
 * documented in docs/EXTENDING.md.
 *
 * Endpoint facts (verified against the live gateway):
 *   base URL   https://api.kilo.ai/api/gateway/v1
 *   chat       POST /chat/completions
 *   models     GET  /models  ->  { data: [{ id, name, ... }] }
 *   auth       Authorization: Bearer <KILO_API_KEY>
 *
 * Gateway quirks this provider exists to absorb:
 *
 *  1. Reasoning models. `message.content` may be null while `message.reasoning`
 *     carries the chain of thought. Measured: a three word answer cost 481
 *     well above the framework default of 1024.
 *
 *  2. Errors masquerade as HTTP 200. A paid model on a negative balance answers
 *     200 with `{"error":{...},"error_type":"usage_limit_exceeded"}` and NO
 *     `choices` array; a naive OpenAI client reads choices[0] and crashes on
 *     undefined. We inspect the error envelope BEFORE touching choices. Note the
 *     two shapes: `error` is an OBJECT there, but a plain STRING for a real 400
 *     (`{"error":"Invalid path","error_type":"invalid_path"}`). Both are parsed.
 *
 *  3. The gateway does not validate the bearer token: a bogus key still returns
 *     a 200 completion. `health()` can therefore only prove reachability, never
 *     key validity - do not read ok:true as "the credentials work".
 *
 * Hard rules honoured (same as src/ai/openai-compatible.ts):
 *   - only AIError ever escapes chat(); no raw fetch/JSON failure does;
 *   - every attempt clears its timeout in a finally;
 *   - health() never throws.
 */

import type { AIConfig } from '../../src/config/schema.js';
import type { EventBus } from '../../src/core/event.js';
import type { Logger } from '../../src/core/logger.js';
import type { ProviderFactory } from '../../src/core/registries.js';
import type { ChatMessage } from '../../src/core/types.js';
import {
  AIError,
  type AIErrorKind,
  type AIProvider,
  type AIResponse,
  type AIUsage,
  type ChatOptions,
} from '../../src/ai/types.js';

export const KILO_PROVIDER_NAME = 'kilo';
export const KILO_DEFAULT_BASE_URL = 'https://api.kilo.ai/api/gateway/v1';
export const KILO_DEFAULT_MODEL = 'tencent/hy3:free';
/** Reasoning eats the budget; 1024 is not enough on this gateway. */

/** What AIConfigSchema falls back to when a bot yaml stays silent. */
const FRAMEWORK_DEFAULTS = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  temperature: 0.8,
  timeoutMs: 60_000,
  retries: 2,
  retryBaseDelayMs: 500,
} as const;

const MAX_RETRY_AFTER_MS = 30_000;
const HEALTH_TIMEOUT_MS = 5_000;
const ERROR_BODY_LIMIT = 300;

/* ------------------------------------------------------------------ types */

/**
 * AIResponse plus the reasoning metadata the base contract has no field for.
 * Widening the return type keeps `implements AIProvider` valid without editing
 * src/ai/types.ts.
 */
export interface KiloAIResponse extends AIResponse {
  /** Chain of thought returned by the model, kept out of `content`. */
  reasoning?: string;
  reasoningTokens?: number;
  /** True when the model produced ONLY reasoning and no answer. */
  reasoningOnly?: boolean;
}

export interface KiloSettings {
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: number;
  timeoutMs: number;
  retries: number;
  retryBaseDelayMs: number;
  stream: boolean;
}

export interface KiloProviderDeps {
  logger: Logger;
  events?: EventBus;
  botId?: string;
  /** Injectable fetch so tests never touch the network. */
  fetchImpl?: typeof fetch;
}

export interface KiloGatewayError {
  message: string;
  errorType?: string;
  title?: string;
  balance?: number;
}

interface AttemptErrorInit {
  kind: AIErrorKind;
  status?: number;
  attempts?: number;
  retryable?: boolean;
  cause?: unknown;
  retryAfterMs?: number;
}

/** Internal: an AIError that can carry a server requested backoff. */
class AttemptError extends AIError {
  readonly retryAfterMs?: number;

  constructor(message: string, init: AttemptErrorInit) {
    super(message, init);
    this.retryAfterMs = init.retryAfterMs;
  }
}

interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
}

/* -------------------------------------------------------------- utilities */

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** Remove ```think...``` blocks some gateways leak into `content`. */
function stripThink(content: string): string {
  return content.replace(/<think[\s\S]*?<\/think>/gi, '').trim();
}

/** A config value only counts as "set by the user" if it differs from the schema default. */
function explicitString(value: unknown, frameworkDefault: string): string | undefined {
  const s = asString(value);
  return s !== undefined && s !== frameworkDefault ? s : undefined;
}

function explicitNumber(value: unknown, frameworkDefault: number): number | undefined {
  const n = asNumber(value);
  return n !== undefined && n !== frameworkDefault ? n : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortLike(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function toUsage(raw: unknown): AIUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as RawUsage;
  const usage: AIUsage = {};
  if (typeof u.prompt_tokens === 'number') usage.promptTokens = u.prompt_tokens;
  if (typeof u.completion_tokens === 'number') usage.completionTokens = u.completion_tokens;
  if (typeof u.total_tokens === 'number') usage.totalTokens = u.total_tokens;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

export function reasoningTokensOf(raw: unknown): number | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  return asNumber((raw as RawUsage).completion_tokens_details?.reasoning_tokens);
}

/** HTTP status -> error kind + whether another attempt could help. */
export function classifyStatus(status: number): { kind: AIErrorKind; retryable: boolean } {
  if (status === 401 || status === 403) return { kind: 'auth', retryable: false };
  if (status === 400 || status === 404 || status === 422) return { kind: 'bad_request', retryable: false };
  if (status === 408) return { kind: 'timeout', retryable: true };
  if (status === 429) return { kind: 'rate_limit', retryable: true };
  if (status >= 500) return { kind: 'server', retryable: true };
  if (status >= 400) return { kind: 'bad_request', retryable: false };
  return { kind: 'unknown', retryable: false };
}

/** `Retry-After` is either delta-seconds or an HTTP date. Capped at 30s. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    if (seconds < 0) return undefined;
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  const delta = date - now;
  if (delta <= 0) return 0;
  return Math.min(delta, MAX_RETRY_AFTER_MS);
}

/**
 * Pull an error envelope out of a gateway body, whichever shape it uses.
 *
 *   object form (HTTP 200!):
 *     {"error":{"title":"Paid Model - Credits Required","message":"...",
 *       "balance":-0.008184,"buyCreditsUrl":"..."},"error_type":"usage_limit_exceeded"}
 *   string form (real HTTP 400):
 *     {"error":"Invalid path","error_type":"invalid_path"}
 *
 * Returns undefined when the body carries no error at all.
 */
export function extractGatewayError(body: unknown): KiloGatewayError | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const root = body as { error?: unknown; error_type?: unknown; message?: unknown };
  const errorType = asString(root.error_type);
  const raw = root.error;

  if (typeof raw === 'string') {
    const message = asString(raw);
    if (!message) return undefined;
    return { message, errorType };
  }

  if (raw && typeof raw === 'object') {
    const e = raw as { message?: unknown; title?: unknown; type?: unknown; code?: unknown; balance?: unknown };
    const title = asString(e.title);
    const message = asString(e.message) ?? title ?? 'kilo gateway returned an error envelope';
    return {
      message: title && title !== message ? `${title}: ${message}` : message,
      errorType: errorType ?? asString(e.type) ?? asString(e.code),
      title,
      balance: asNumber(e.balance),
    };
  }

  // `error_type` alone still means failure (no choices will follow).
  if (errorType) return { message: asString(root.message) ?? `kilo gateway error (${errorType})`, errorType };
  return undefined;
}

/**
 * Map a gateway error envelope onto the AIError taxonomy.
 *
 * AIErrorKind lives in src/ai/types.ts and must not grow a `quota` member from
 * a plugin, so credit exhaustion is reported as a NON-RETRYABLE `auth` error -
 * retrying cannot possibly fix a negative balance.
 */
export function classifyGatewayError(
  error: KiloGatewayError,
  status?: number,
): { kind: AIErrorKind; retryable: boolean } {
  const tag = `${error.errorType ?? ''} ${error.message}`.toLowerCase();

  if (/usage_limit|credit|quota|billing|insufficient|payment/.test(tag)) {
    return { kind: 'auth', retryable: false };
  }
  if (/unauthor|forbidden|api[_ -]?key|invalid[_ -]?token|auth/.test(tag)) {
    return { kind: 'auth', retryable: false };
  }
  if (/rate[_ -]?limit|too many requests/.test(tag)) return { kind: 'rate_limit', retryable: true };
  if (/timeout|timed out|deadline/.test(tag)) return { kind: 'timeout', retryable: true };
  if (/invalid|not[_ -]?found|bad[_ -]?request|unsupported|malformed/.test(tag)) {
    return { kind: 'bad_request', retryable: false };
  }
  if (/upstream|internal|server|unavailable|overload/.test(tag)) return { kind: 'server', retryable: true };
  if (typeof status === 'number' && status >= 400) return classifyStatus(status);
  return { kind: 'unknown', retryable: false };
}

/* ------------------------------------------------------------- settings */

/**
 * Resolve effective settings.
 *
 * Precedence, highest first:
 *   1. `ai.options.<key>`        - passthrough block, always explicit
 *   2. `ai.<key>`                - only when it differs from the schema default
 *   3. `plugin.json` -> config   - the plugin's own defaults
 *   4. the Kilo defaults in this file
 *
 * The API key is NEVER read from plugin.json: it comes from `ai.apiKey`
 * (injected from env by the config loader) or straight from `KILO_API_KEY`.
 */
export function resolveKiloSettings(
  cfg?: Partial<AIConfig>,
  pluginConfig: Record<string, unknown> = {},
  env: Record<string, string | undefined> = process.env,
): KiloSettings {
  const opt = (cfg?.options ?? {}) as Record<string, unknown>;
  const pc = pluginConfig;

  // Respect a loader-selected gateway (including compatible private proxies).
  // A framework-default OpenAI URL is not an intentional Kilo endpoint.
  const configuredBaseUrl = asString(opt.baseUrl) ?? explicitString(cfg?.baseUrl, FRAMEWORK_DEFAULTS.baseUrl) ?? asString(pc.baseUrl);
  const baseUrl = configuredBaseUrl && configuredBaseUrl !== FRAMEWORK_DEFAULTS.baseUrl ? configuredBaseUrl : KILO_DEFAULT_BASE_URL;

  const model =
    asString(opt.model) ??
    explicitString(cfg?.model, FRAMEWORK_DEFAULTS.model) ??
    asString(pc.defaultModel) ??
    asString(pc.model) ??
    KILO_DEFAULT_MODEL;

  const temperature =
    asNumber(opt.temperature) ??
    explicitNumber(cfg?.temperature, FRAMEWORK_DEFAULTS.temperature) ??
    asNumber(pc.temperature) ??
    FRAMEWORK_DEFAULTS.temperature;

  const timeoutMs =
    asNumber(opt.timeoutMs) ??
    explicitNumber(cfg?.timeoutMs, FRAMEWORK_DEFAULTS.timeoutMs) ??
    asNumber(pc.timeoutMs) ??
    FRAMEWORK_DEFAULTS.timeoutMs;

  const retries =
    asNumber(opt.retries) ??
    explicitNumber(cfg?.retries, FRAMEWORK_DEFAULTS.retries) ??
    asNumber(pc.retries) ??
    FRAMEWORK_DEFAULTS.retries;

  const retryBaseDelayMs =
    asNumber(opt.retryBaseDelayMs) ??
    explicitNumber(cfg?.retryBaseDelayMs, FRAMEWORK_DEFAULTS.retryBaseDelayMs) ??
    asNumber(pc.retryBaseDelayMs) ??
    FRAMEWORK_DEFAULTS.retryBaseDelayMs;

  const stream = asBoolean(opt.stream) ?? asBoolean(cfg?.stream) ?? asBoolean(pc.stream) ?? false;

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    apiKey: asString(cfg?.apiKey) ?? asString(env.KILO_API_KEY) ?? '',
    temperature,
    timeoutMs,
    retries: Math.max(0, Math.trunc(retries)),
    retryBaseDelayMs: Math.max(1, Math.trunc(retryBaseDelayMs)),
    stream,
  };
}

/* -------------------------------------------------------------- provider */

export class KiloProvider implements AIProvider {
  readonly name = KILO_PROVIDER_NAME;

  readonly #settings: KiloSettings;
  readonly #logger: Logger;
  readonly #events: EventBus | undefined;
  readonly #botId: string;
  readonly #fetch: typeof fetch;

  constructor(settings: KiloSettings, deps: KiloProviderDeps) {
    this.#settings = settings;
    this.#logger = deps.logger;
    this.#events = deps.events;
    this.#botId = deps.botId ?? 'unknown';
    this.#fetch = deps.fetchImpl ?? globalThis.fetch;
  }

  get model(): string {
    return this.#settings.model;
  }

  /** Read-only view, handy for diagnostics and tests. */
  get settings(): Readonly<KiloSettings> {
    return this.#settings;
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<KiloAIResponse> {
    const model = options.model ?? this.#settings.model;

    // The plugin loads fine without a key; the failure surfaces here, loudly.
    if (this.#settings.apiKey === '') {
      throw new AIError(
        'kilo: no API key configured. Set KILO_API_KEY in the environment ' +
          '(or ai.apiKey for this bot) - the plugin loads without it but cannot call the gateway.',
        { kind: 'auth', attempts: 0, retryable: false },
      );
    }

    const maxAttempts = Math.max(1, this.#settings.retries + 1);
    this.#events?.emit('ai:request', { botId: this.#botId, model, messages: messages.length });

    let lastError: AttemptError = new AttemptError('no attempt was made', {
      kind: 'unknown',
      attempts: 0,
      retryable: false,
    });
    let attemptsMade = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attemptsMade = attempt;
      try {
        const response = await this.#attempt(messages, options, model);
        this.#events?.emit('ai:response', {
          botId: this.#botId,
          model: response.model,
          ms: response.ms,
          tokens: response.usage?.totalTokens,
        });
        return response;
      } catch (error) {
        lastError =
          error instanceof AttemptError
            ? error
            : new AttemptError(errorMessage(error), {
                kind: error instanceof AIError ? error.kind : 'unknown',
                status: error instanceof AIError ? error.status : undefined,
                retryable: error instanceof AIError ? error.retryable : false,
                cause: error,
              });

        this.#events?.emit('ai:error', { botId: this.#botId, error: lastError.message, attempt });
        this.#logger.warn(
          { kind: lastError.kind, status: lastError.status, attempt, maxAttempts, model },
          `kilo request failed: ${lastError.message}`,
        );

        const canRetry = lastError.retryable && attempt < maxAttempts;
        if (!canRetry) break;
        await sleep(this.#backoffMs(attempt, lastError.retryAfterMs));
      }
    }

    throw new AIError(lastError.message, {
      kind: lastError.kind,
      status: lastError.status,
      attempts: Math.max(1, attemptsMade),
      retryable: lastError.retryable,
      cause: lastError.cause ?? lastError,
    });
  }

  /** Exponential backoff with +-20% jitter; a Retry-After hint wins. */
  #backoffMs(attempt: number, retryAfterMs?: number): number {
    if (typeof retryAfterMs === 'number') return Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
    const base = this.#settings.retryBaseDelayMs * Math.pow(2, attempt - 1);
    const jitter = 0.8 + Math.random() * 0.4;
    return Math.max(0, Math.round(base * jitter));
  }

  #headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.#settings.apiKey) headers.Authorization = `Bearer ${this.#settings.apiKey}`;
    return headers;
  }

  async #attempt(messages: ChatMessage[], options: ChatOptions, model: string): Promise<KiloAIResponse> {
    const started = Date.now();
    const timeoutMs = options.timeoutMs ?? this.#settings.timeoutMs;
    const stream = Boolean((options.stream ?? this.#settings.stream) && options.onDelta);

    const controller = new AbortController();
    let timedOut = false;
    const external = options.signal;
    const onExternalAbort = (): void => controller.abort();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      const body = JSON.stringify({
        model,
        messages: messages.map((m) => {
          // The core summarizer stores compressed history under the internal
          // `summary` role; the OpenAI-compatible wire has no such role, so it
          // is sent as a labelled `user` turn.
          const role = m.role === 'summary' ? 'user' : m.role;
          const content = m.role === 'summary' ? `[对话摘要]\n${m.content}` : m.content;
          return m.name ? { role, content, name: m.name } : { role, content };
        }),
        temperature: options.temperature ?? this.#settings.temperature,
        stream,
        ...(stream ? { stream_options: { include_usage: true } } : {}),
      });

      let res: Response;
      try {
        res = await this.#fetch(`${this.#settings.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: this.#headers(),
          body,
          signal: controller.signal,
        });
      } catch (error) {
        throw this.#transportError(error, external, timedOut, timeoutMs);
      }

      // A non-2xx body may still hold a gateway envelope - parse it for detail.
      if (!res.ok) throw await this.#httpError(res);

      return stream
        ? await this.#readStream(res, model, started, options, external, () => timedOut, timeoutMs)
        : await this.#readJson(res, model, started, external, () => timedOut, timeoutMs);
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
    }
  }

  #transportError(
    error: unknown,
    external: AbortSignal | undefined,
    timedOut: boolean,
    timeoutMs: number,
  ): AttemptError {
    if (external?.aborted) {
      return new AttemptError('request aborted by caller', { kind: 'aborted', retryable: false, cause: error });
    }
    if (timedOut || isAbortLike(error)) {
      return new AttemptError(`kilo request timed out after ${timeoutMs}ms`, {
        kind: 'timeout',
        retryable: true,
        cause: error,
      });
    }
    return new AttemptError(`network error: ${errorMessage(error)}`, {
      kind: 'network',
      retryable: true,
      cause: error,
    });
  }

  async #httpError(res: Response): Promise<AttemptError> {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, ERROR_BODY_LIMIT);
    } catch {
      /* body unreadable - the status alone is enough */
    }

    let parsed: unknown;
    try {
      parsed = detail ? JSON.parse(detail) : undefined;
    } catch {
      parsed = undefined;
    }

    const envelope = extractGatewayError(parsed);
    const { kind, retryable } = envelope
      ? classifyGatewayError(envelope, res.status)
      : classifyStatus(res.status);
    const retryAfterMs = kind === 'rate_limit' ? parseRetryAfter(res.headers?.get?.('retry-after')) : undefined;
    const message = envelope
      ? `kilo HTTP ${res.status} [${envelope.errorType ?? 'error'}]: ${envelope.message}`
      : `kilo HTTP ${res.status}${detail ? `: ${detail}` : ''}`;

    return new AttemptError(message, { kind, status: res.status, retryable, retryAfterMs });
  }

  /** Turn a 200-with-error envelope into the right AIError. */
  #gatewayError(envelope: KiloGatewayError, status: number): AttemptError {
    const { kind, retryable } = classifyGatewayError(envelope, status);
    const balance = envelope.balance !== undefined ? ` (balance ${envelope.balance})` : '';
    return new AttemptError(
      `kilo gateway error [${envelope.errorType ?? 'unknown'}]: ${envelope.message}${balance}`,
      { kind, status, retryable },
    );
  }

  async #readJson(
    res: Response,
    model: string,
    started: number,
    external: AbortSignal | undefined,
    timedOut: () => boolean,
    timeoutMs: number,
  ): Promise<KiloAIResponse> {
    let json: unknown;
    try {
      json = await res.json();
    } catch (error) {
      throw this.#transportError(error, external, timedOut(), timeoutMs);
    }

    // QUIRK 2: check the error envelope BEFORE reading choices - the gateway
    // returns HTTP 200 with no `choices` when credits run out.
    const envelope = extractGatewayError(json);
    if (envelope) throw this.#gatewayError(envelope, res.status);

    const payload = (json ?? {}) as {
      model?: string;
      usage?: unknown;
      choices?: Array<{
        message?: { content?: string | null; reasoning?: string | null; reasoning_content?: string | null };
        finish_reason?: string;
      }>;
    };

    const choice = payload.choices?.[0];
    if (!choice) {
      throw new AttemptError('kilo: response carried neither choices nor an error envelope', {
        kind: 'unknown',
        status: res.status,
        retryable: false,
      });
    }

    const message = choice.message ?? {};
    return this.#finalize({
      content: stripThink(typeof message.content === 'string' ? message.content : ''),
      reasoning:
        (typeof message.reasoning === 'string' ? message.reasoning : undefined) ??
        (typeof message.reasoning_content === 'string' ? message.reasoning_content : '') ??
        '',
      model: payload.model ?? model,
      usage: toUsage(payload.usage),
      reasoningTokens: reasoningTokensOf(payload.usage),
      finishReason: choice.finish_reason,
      started,
    });
  }

  async #readStream(
    res: Response,
    model: string,
    started: number,
    options: ChatOptions,
    external: AbortSignal | undefined,
    timedOut: () => boolean,
    timeoutMs: number,
  ): Promise<KiloAIResponse> {
    const body = res.body;
    if (!body || typeof body.getReader !== 'function') {
      throw new AttemptError('kilo: streaming response had no readable body', {
        kind: 'network',
        status: res.status,
        retryable: true,
      });
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let reasoning = '';
    let resolvedModel = model;
    let finishReason: string | undefined;
    let usage: AIUsage | undefined;
    let reasoningTokens: number | undefined;
    let streamError: AttemptError | undefined;
    let done = false;

    const handleLine = (rawLine: string): void => {
      const line = rawLine.replace(/\r$/, '').trim();
      if (line === '' || !line.startsWith('data:')) return;
      const payloadText = line.slice(5).trim();
      if (payloadText === '[DONE]') {
        done = true;
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(payloadText);
      } catch {
        return; // malformed SSE frames are skipped, never thrown
      }

      // An error can arrive mid-stream too; same envelope shapes.
      const envelope = extractGatewayError(parsed);
      if (envelope) {
        streamError ??= this.#gatewayError(envelope, res.status);
        done = true;
        return;
      }

      const chunk = (parsed ?? {}) as {
        model?: string;
        usage?: unknown;
        choices?: Array<{
          delta?: { content?: string | null; reasoning?: string | null; reasoning_content?: string | null };
          finish_reason?: string;
        }>;
      };

      if (typeof chunk.model === 'string') resolvedModel = chunk.model;
      const parsedUsage = toUsage(chunk.usage);
      if (parsedUsage) usage = parsedUsage;
      const parsedReasoningTokens = reasoningTokensOf(chunk.usage);
      if (parsedReasoningTokens !== undefined) reasoningTokens = parsedReasoningTokens;

      const choice = chunk.choices?.[0];
      if (!choice) return;
      if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;

      // QUIRK 1 (streaming): reasoning deltas are NOT part of the answer.
      const reasoningDelta = choice.delta?.reasoning ?? choice.delta?.reasoning_content;
      if (typeof reasoningDelta === 'string' && reasoningDelta.length > 0) reasoning += reasoningDelta;

      const delta = choice.delta?.content;
      if (typeof delta === 'string' && delta.length > 0) {
        content += delta;
        try {
          options.onDelta?.(delta);
        } catch (error) {
          this.#logger.warn({ error: errorMessage(error) }, 'kilo: onDelta handler threw; ignoring');
        }
      }
    };

    try {
      while (!done) {
        const { done: streamDone, value } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: true });
        if (streamDone) break;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) handleLine(line);
      }
      buffer += decoder.decode();
      for (const line of buffer.split('\n')) handleLine(line);
    } catch (error) {
      throw this.#transportError(error, external, timedOut(), timeoutMs);
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* the stream is already gone - nothing to do */
      }
    }

    if (streamError) throw streamError;

    return this.#finalize({
      content,
      reasoning,
      model: resolvedModel,
      usage,
      reasoningTokens,
      finishReason,
      started,
    });
  }

  /**
   * QUIRK 1: never hand back an empty string when the model only produced a
   * chain of thought - that looks like "the bot ignored you". The reasoning is
   * attached to the response AND summarised into a diagnosable content line.
   */
  #finalize(input: {
    content: string;
    reasoning: string;
    model: string;
    usage?: AIUsage;
    reasoningTokens?: number;
    finishReason?: string;
    started: number;
  }): KiloAIResponse {
    let content = stripThink(input.content);
    let reasoningOnly = false;

    if (content.trim() === '' && input.reasoning.trim() !== '') {
      reasoningOnly = true;
      this.#logger.warn(
        {
          model: input.model,
          reasoningTokens: input.reasoningTokens,
          finishReason: input.finishReason,
        },
        'kilo: model returned reasoning but no answer (token budget consumed by chain-of-thought)',
      );
      // The model spent its whole budget on reasoning; there is no user-facing
      // answer. Surface this as a proper error so the pipeline shows a friendly
      // message instead of echoing a raw diagnostic string into chat.
      throw new AIError(
        'kilo: no answer emitted - the reasoning chain consumed the token budget',
        { kind: 'server', attempts: 0, retryable: false, status: undefined },
      );
    }

    const response: KiloAIResponse = {
      content,
      model: input.model,
      usage: input.usage,
      finishReason: input.finishReason,
      ms: Date.now() - input.started,
    };
    if (input.reasoning !== '') response.reasoning = input.reasoning;
    if (input.reasoningTokens !== undefined) response.reasoningTokens = input.reasoningTokens;
    if (reasoningOnly) response.reasoningOnly = true;
    return response;
  }

  /**
   * Liveness probe against GET /models.
   *
   * QUIRK 3: the gateway does NOT validate the bearer token - a bogus key still
   * gets HTTP 200 on both /models and /chat/completions. So this can only prove
   * that the endpoint is reachable and answering; it can NEVER prove the key is
   * valid, and a failure here is a connectivity problem, not an auth problem.
   * Never throws.
   */
  async health(): Promise<{ ok: boolean; detail?: string }> {
    if (this.#settings.apiKey === '') {
      return {
        ok: false,
        detail: 'KILO_API_KEY is not set; chat() will fail (note: the gateway cannot verify keys anyway)',
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      const res = await this.#fetch(`${this.#settings.baseUrl}/models`, {
        method: 'GET',
        headers: this.#headers(),
        signal: controller.signal,
      });
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };

      let json: unknown;
      try {
        json = await res.json();
      } catch {
        return { ok: false, detail: 'GET /models returned a non-JSON body' };
      }

      const envelope = extractGatewayError(json);
      if (envelope) return { ok: false, detail: `${envelope.errorType ?? 'error'}: ${envelope.message}` };

      const data = (json as { data?: unknown } | null)?.data;
      if (!Array.isArray(data)) return { ok: false, detail: 'GET /models had no data array' };
      return { ok: true, detail: `reachable, ${data.length} models (key validity NOT verifiable)` };
    } catch (error) {
      return { ok: false, detail: errorMessage(error) };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Build the ProviderFactory registered under the name `kilo`.
 * `pluginConfig` is the frozen `config` block from plugin.json.
 */
export function createKiloProviderFactory(pluginConfig: Record<string, unknown> = {}): ProviderFactory {
  return (cfg, deps) =>
    new KiloProvider(resolveKiloSettings(cfg, pluginConfig), {
      logger: deps.logger,
      events: deps.events,
      botId: deps.botId,
      fetchImpl: deps.fetchImpl,
    });
}
