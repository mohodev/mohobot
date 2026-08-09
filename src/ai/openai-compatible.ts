/**
 * OpenAI-compatible chat provider.
 *
 * Works against any endpoint exposing `POST {baseUrl}/chat/completions`
 * (OpenAI, DeepSeek, Groq, Ollama, vLLM, LM Studio, ...).
 *
 * Hard rules honoured here:
 *  - only `AIError` ever escapes `chat()`; a raw fetch/JSON failure never does;
 *  - every attempt clears its timeout in a `finally`;
 *  - `health()` never throws.
 */

import type { AIConfig } from '../config/schema.js';
import type { EventBus } from '../core/event.js';
import type { Logger } from '../core/logger.js';
import type { ChatMessage } from '../core/types.js';
import {
  AIError,
  type AIErrorKind,
  type AIProvider,
  type AIResponse,
  type AIUsage,
  type ChatOptions,
} from './types.js';

export interface OpenAICompatibleDeps {
  logger: Logger;
  events?: EventBus;
  botId?: string;
  /** Injectable fetch so tests never touch the network. */
  fetchImpl?: typeof fetch;
}

/** A 429 may not ask us to wait longer than this. */
const MAX_RETRY_AFTER_MS = 30_000;
const HEALTH_TIMEOUT_MS = 5_000;
const ERROR_BODY_LIMIT = 300;

interface AttemptErrorInit {
  kind: AIErrorKind;
  status?: number;
  attempts?: number;
  retryable?: boolean;
  cause?: unknown;
  retryAfterMs?: number;
}

/** Internal: an AIError that can carry a server-requested backoff. */
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
}

function toUsage(raw: unknown): AIUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as RawUsage;
  const usage: AIUsage = {};
  if (typeof u.prompt_tokens === 'number') usage.promptTokens = u.prompt_tokens;
  if (typeof u.completion_tokens === 'number') usage.completionTokens = u.completion_tokens;
  if (typeof u.total_tokens === 'number') usage.totalTokens = u.total_tokens;
  return Object.keys(usage).length > 0 ? usage : undefined;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isAbortLike(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

export class OpenAICompatibleProvider implements AIProvider {
  readonly name = 'openai-compatible';

  readonly #cfg: AIConfig;
  readonly #logger: Logger;
  readonly #events: EventBus | undefined;
  readonly #botId: string;
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;

  constructor(cfg: AIConfig, deps: OpenAICompatibleDeps) {
    this.#cfg = cfg;
    this.#logger = deps.logger;
    this.#events = deps.events;
    this.#botId = deps.botId ?? 'unknown';
    this.#fetch = deps.fetchImpl ?? globalThis.fetch;
    this.#baseUrl = cfg.baseUrl.replace(/\/+$/, '');
  }

  get model(): string {
    return this.#cfg.model;
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<AIResponse> {
    const model = options.model ?? this.#cfg.model;
    const maxAttempts = Math.max(1, this.#cfg.retries + 1);

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
          `AI request failed: ${lastError.message}`,
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

  /** exponential backoff with +-20% jitter; a Retry-After hint wins. */
  #backoffMs(attempt: number, retryAfterMs?: number): number {
    if (typeof retryAfterMs === 'number') return Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
    const base = this.#cfg.retryBaseDelayMs * Math.pow(2, attempt - 1);
    const jitter = 0.8 + Math.random() * 0.4;
    return Math.max(0, Math.round(base * jitter));
  }

  #headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.#cfg.apiKey) headers.Authorization = `Bearer ${this.#cfg.apiKey}`;
    return headers;
  }

  async #attempt(messages: ChatMessage[], options: ChatOptions, model: string): Promise<AIResponse> {
    const started = Date.now();
    const timeoutMs = options.timeoutMs ?? this.#cfg.timeoutMs;
    const stream = Boolean((options.stream ?? this.#cfg.stream) && options.onDelta);

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
        messages: messages.map((m) => (m.name ? { role: m.role, content: m.content, name: m.name } : { role: m.role, content: m.content })),
        temperature: options.temperature ?? this.#cfg.temperature,
        max_tokens: options.maxTokens ?? this.#cfg.maxTokens,
        stream,
      });

      let res: Response;
      try {
        res = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
          method: 'POST',
          headers: this.#headers(),
          body,
          signal: controller.signal,
        });
      } catch (error) {
        throw this.#transportError(error, external, timedOut);
      }

      if (!res.ok) throw await this.#httpError(res);

      return stream
        ? await this.#readStream(res, model, started, options, external, () => timedOut)
        : await this.#readJson(res, model, started, external, () => timedOut);
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
    }
  }

  #transportError(error: unknown, external: AbortSignal | undefined, timedOut: boolean): AttemptError {
    if (external?.aborted) {
      return new AttemptError('request aborted by caller', { kind: 'aborted', retryable: false, cause: error });
    }
    if (timedOut || isAbortLike(error)) {
      return new AttemptError(`request timed out after ${this.#cfg.timeoutMs}ms`, {
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
    const { kind, retryable } = classifyStatus(res.status);
    let detail = '';
    try {
      detail = (await res.text()).slice(0, ERROR_BODY_LIMIT);
    } catch {
      /* body already consumed or unreadable - the status is enough */
    }
    const retryAfterMs = kind === 'rate_limit' ? parseRetryAfter(res.headers?.get?.('retry-after')) : undefined;
    return new AttemptError(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`, {
      kind,
      status: res.status,
      retryable,
      retryAfterMs,
    });
  }

  async #readJson(
    res: Response,
    model: string,
    started: number,
    external: AbortSignal | undefined,
    timedOut: () => boolean,
  ): Promise<AIResponse> {
    let json: unknown;
    try {
      json = await res.json();
    } catch (error) {
      throw this.#transportError(error, external, timedOut());
    }

    const payload = (json ?? {}) as {
      model?: string;
      usage?: unknown;
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    };
    const choice = payload.choices?.[0];
    return {
      content: choice?.message?.content ?? '',
      model: payload.model ?? model,
      usage: toUsage(payload.usage),
      finishReason: choice?.finish_reason,
      ms: Date.now() - started,
    };
  }

  async #readStream(
    res: Response,
    model: string,
    started: number,
    options: ChatOptions,
    external: AbortSignal | undefined,
    timedOut: () => boolean,
  ): Promise<AIResponse> {
    const body = res.body;
    if (!body || typeof body.getReader !== 'function') {
      throw new AttemptError('streaming response had no readable body', {
        kind: 'network',
        status: res.status,
        retryable: true,
      });
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let resolvedModel = model;
    let finishReason: string | undefined;
    let usage: AIUsage | undefined;
    let done = false;

    const handleLine = (rawLine: string): void => {
      const line = rawLine.replace(/\r$/, '').trim();
      if (line === '' || !line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') {
        done = true;
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        return; // malformed SSE frames are skipped, never thrown
      }
      const chunk = (parsed ?? {}) as {
        model?: string;
        usage?: unknown;
        choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>;
      };
      if (typeof chunk.model === 'string') resolvedModel = chunk.model;
      const parsedUsage = toUsage(chunk.usage);
      if (parsedUsage) usage = parsedUsage;
      const choice = chunk.choices?.[0];
      if (!choice) return;
      if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
      const delta = choice.delta?.content;
      if (typeof delta === 'string' && delta.length > 0) {
        content += delta;
        try {
          options.onDelta?.(delta);
        } catch (error) {
          this.#logger.warn({ error: errorMessage(error) }, 'onDelta handler threw; ignoring');
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
      throw this.#transportError(error, external, timedOut());
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* the stream is already gone - nothing to do */
      }
    }

    return {
      content,
      model: resolvedModel,
      usage,
      finishReason,
      ms: Date.now() - started,
    };
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    if (!this.#cfg.apiKey) {
      return { ok: false, detail: 'apiKey is empty - provider cannot authenticate' };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      const res = await this.#fetch(`${this.#baseUrl}/models`, {
        method: 'GET',
        headers: this.#headers(),
        signal: controller.signal,
      });
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: errorMessage(error) };
    } finally {
      clearTimeout(timer);
    }
  }
}
