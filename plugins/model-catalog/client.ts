/**
 * Kilo AI gateway client for the model catalog.
 *
 * Two responsibilities, both defensive:
 *  - fetch and cache GET /models (memory cache + plugin-scoped storage, TTL)
 *  - optionally probe a model with a one-token request to see if it really works
 *
 * Every failure mode observed against the live gateway is turned into a short
 * readable Error message: network refusal, timeout, non-2xx, non-JSON body,
 * empty catalog, and - the sneaky one - HTTP 200 whose body is an error object
 * with no `choices` (that is what a paid model returns on a credit-less
 * account). The API key is never logged, never returned, never persisted.
 */

import { scrub, type Logger } from '../../src/core/logger.js';
import type { ScopedStorage } from '../../src/storage/types.js';
import { parseModels, type CatalogModel } from './catalog.js';

export interface MinimalResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export interface MinimalRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/** Structural subset of global fetch, so tests can inject a fake. */
export type FetchLike = (url: string, init?: MinimalRequestInit) => Promise<MinimalResponse>;

export interface CatalogClientOptions {
  apiKey?: string;
  /** Default: https://api.kilo.ai/api/gateway/v1 */
  baseUrl?: string;
  fetch?: FetchLike;
  /** Per-request timeout for /models. Default 15000ms. */
  timeoutMs?: number;
  /** Cache lifetime. Default 3600s. */
  ttlSeconds?: number;
  storage?: ScopedStorage;
  logger?: Logger;
  /** Injectable clock, used by tests to age the cache. */
  now?: () => number;
}

export type CatalogSource = 'network' | 'memory-cache' | 'storage-cache' | 'stale-cache';

export interface CatalogSnapshot {
  models: CatalogModel[];
  fetchedAt: number;
  source: CatalogSource;
  /** Set when the network failed and a stale cache was served instead. */
  warning?: string;
}

export interface ProbeResult {
  modelId: string;
  ok: boolean;
  /** HTTP status, when a response was received at all. */
  status?: number;
  latencyMs: number;
  /** Short human readable reason; always populated when ok === false. */
  reason?: string;
  /** First characters of the reply, when the model actually answered. */
  sample?: string;
}

export interface ProbeOptions {
  /** Per-model timeout. Default 20000ms. */
  timeoutMs?: number;
  /** Hard ceiling for the whole sweep. Default 90000ms. */
  budgetMs?: number;
  /** Max models to try. Default 10. */
  limit?: number;
  prompt?: string;
}

export const DEFAULT_BASE_URL = 'https://api.kilo.ai/api/gateway/v1';
export const CACHE_KEY = 'catalog:models:v1';

interface CachedCatalog {
  fetchedAt: number;
  models: CatalogModel[];
}

function defaultFetch(): FetchLike | undefined {
  const candidate = (globalThis as { fetch?: unknown }).fetch;
  return typeof candidate === 'function' ? (candidate as FetchLike) : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'unknown error';
}

function isAbort(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'AbortError' || error.name === 'TimeoutError';
}

/** Keep error bodies short and free of anything that looks like a credential. */
function safeSnippet(text: string, max = 180): string {
  const flat = scrub(text).replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}\u2026`;
}

export class CatalogClient {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly timeoutMs: number;
  private readonly ttlSeconds: number;
  private readonly storage: ScopedStorage | undefined;
  private readonly logger: Logger | undefined;
  private readonly now: () => number;

  private memory: CachedCatalog | undefined;
  /** De-duplicates concurrent refreshes so N commands cause one HTTP call. */
  private inFlight: Promise<CatalogSnapshot> | undefined;

  constructor(options: CatalogClientOptions = {}) {
    this.apiKey = options.apiKey?.trim() === '' ? undefined : options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? defaultFetch();
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.ttlSeconds = options.ttlSeconds ?? 3600;
    this.storage = options.storage;
    this.logger = options.logger;
    this.now = options.now ?? (() => Date.now());
  }

  get cacheTtlSeconds(): number {
    return this.ttlSeconds;
  }

  hasCredentials(): boolean {
    return typeof this.apiKey === 'string' && this.apiKey.length > 0;
  }

  /** Drop the in-process cache (storage copy is left to expire on its own TTL). */
  clearMemoryCache(): void {
    this.memory = undefined;
  }

  /**
   * Cached model list. Order of preference:
   * memory -> plugin storage -> network -> stale cache (on network failure).
   */
  async getModels(options: { force?: boolean } = {}): Promise<CatalogSnapshot> {
    const force = options.force === true;
    if (!force) {
      const fresh = this.freshFromMemory();
      if (fresh) return fresh;
      const stored = await this.freshFromStorage();
      if (stored) return stored;
    }
    if (this.inFlight) return this.inFlight;

    const run = this.refresh().finally(() => {
      this.inFlight = undefined;
    });
    this.inFlight = run;
    return run;
  }

  private freshFromMemory(): CatalogSnapshot | undefined {
    const cached = this.memory;
    if (!cached || this.isExpired(cached.fetchedAt)) return undefined;
    return { models: cached.models, fetchedAt: cached.fetchedAt, source: 'memory-cache' };
  }

  private async freshFromStorage(): Promise<CatalogSnapshot | undefined> {
    const cached = await this.readStorage();
    if (!cached || this.isExpired(cached.fetchedAt)) return undefined;
    this.memory = cached;
    return { models: cached.models, fetchedAt: cached.fetchedAt, source: 'storage-cache' };
  }

  private isExpired(fetchedAt: number): boolean {
    return this.now() - fetchedAt >= this.ttlSeconds * 1000;
  }

  private async readStorage(): Promise<CachedCatalog | undefined> {
    if (!this.storage) return undefined;
    try {
      const raw = await this.storage.get<CachedCatalog>(CACHE_KEY);
      if (!raw || typeof raw.fetchedAt !== 'number' || !Array.isArray(raw.models)) return undefined;
      return raw;
    } catch (error) {
      this.logger?.warn({ err: errorMessage(error) }, 'model-catalog: cache read failed');
      return undefined;
    }
  }

  private async writeStorage(payload: CachedCatalog): Promise<void> {
    if (!this.storage) return;
    try {
      await this.storage.save(CACHE_KEY, payload, this.ttlSeconds);
    } catch (error) {
      this.logger?.warn({ err: errorMessage(error) }, 'model-catalog: cache write failed');
    }
  }

  private async refresh(): Promise<CatalogSnapshot> {
    try {
      const models = await this.fetchModels();
      const fetchedAt = this.now();
      const payload: CachedCatalog = { fetchedAt, models };
      this.memory = payload;
      await this.writeStorage(payload);
      this.logger?.info({ count: models.length }, 'model-catalog: refreshed model list');
      return { models, fetchedAt, source: 'network' };
    } catch (error) {
      const message = errorMessage(error);
      const fallback = this.memory ?? (await this.readStorage());
      if (fallback) {
        this.logger?.warn({ err: message }, 'model-catalog: refresh failed, serving stale cache');
        return {
          models: fallback.models,
          fetchedAt: fallback.fetchedAt,
          source: 'stale-cache',
          warning: `refresh failed (${message}); showing cached data`,
        };
      }
      throw error instanceof Error ? error : new Error(message);
    }
  }

  /** Raw network call. Always throws a readable Error, never leaks the key. */
  async fetchModels(): Promise<CatalogModel[]> {
    const body = await this.request('/models', { method: 'GET' }, this.timeoutMs, 'model list');
    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      throw new Error(`model list response was not valid JSON: ${safeSnippet(body, 80)}`);
    }
    const models = parseModels(parsed);
    if (models.length === 0) {
      throw new Error('model list response contained no usable model entries');
    }
    return models;
  }

  /**
   * One tiny completion against a single model.
   *
   * Treats an HTTP 200 carrying `{error:...}` or lacking `choices` as a
   * failure - that is exactly how the gateway reports "Paid Model - Credits
   * Required" without using a 4xx status.
   */
  async probeModel(modelId: string, options: ProbeOptions = {}): Promise<ProbeResult> {
    const started = this.now();
    const timeoutMs = options.timeoutMs ?? 20_000;
    const payload = JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: options.prompt ?? 'Reply with the single word: ok' }],
      max_tokens: 16,
      temperature: 0,
      stream: false,
    });

    try {
      const body = await this.request(
        '/chat/completions',
        { method: 'POST', body: payload, headers: { 'content-type': 'application/json' } },
        timeoutMs,
        `probe ${modelId}`,
      );
      const elapsed = this.now() - started;
      let parsed: unknown;
      try {
        parsed = JSON.parse(body) as unknown;
      } catch {
        return { modelId, ok: false, latencyMs: elapsed, reason: 'reply was not valid JSON' };
      }
      return { ...interpretCompletion(modelId, parsed), latencyMs: elapsed };
    } catch (error) {
      return {
        modelId,
        ok: false,
        latencyMs: this.now() - started,
        reason: errorMessage(error),
      };
    }
  }

  /**
   * Probe models one at a time under a global time budget. Serial on purpose:
   * a burst of parallel completions is the fastest way to get rate limited.
   * Models that never get a turn are reported as skipped, not as broken.
   */
  async probeModels(modelIds: readonly string[], options: ProbeOptions = {}): Promise<ProbeResult[]> {
    const budgetMs = options.budgetMs ?? 90_000;
    const limit = options.limit ?? 10;
    const started = this.now();
    const results: ProbeResult[] = [];
    const targets = modelIds.slice(0, Math.max(0, limit));

    for (const modelId of targets) {
      if (this.now() - started >= budgetMs) {
        results.push({ modelId, ok: false, latencyMs: 0, reason: 'skipped: time budget exhausted' });
        continue;
      }
      const remaining = budgetMs - (this.now() - started);
      const perModel = Math.max(1000, Math.min(options.timeoutMs ?? 20_000, remaining));
      // eslint-disable-next-line no-await-in-loop -- serial by design
      results.push(await this.probeModel(modelId, { ...options, timeoutMs: perModel }));
    }
    return results;
  }

  private async request(
    path: string,
    init: MinimalRequestInit,
    timeoutMs: number,
    label: string,
  ): Promise<string> {
    if (!this.fetchImpl) throw new Error('no fetch implementation available in this runtime');
    if (!this.hasCredentials()) {
      throw new Error('KILO_API_KEY is not set; cannot reach the gateway');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: MinimalResponse;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          accept: 'application/json',
          ...(init.headers ?? {}),
          authorization: `Bearer ${this.apiKey ?? ''}`,
        },
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbort(error)) throw new Error(`${label} timed out after ${timeoutMs}ms`);
      throw new Error(`${label} request failed: ${scrub(errorMessage(error))}`);
    } finally {
      clearTimeout(timer);
    }

    let body: string;
    try {
      body = await response.text();
    } catch (error) {
      throw new Error(`${label} response could not be read: ${scrub(errorMessage(error))}`);
    }

    if (!response.ok) {
      throw new Error(`${label} failed: HTTP ${response.status} ${safeSnippet(body)}`);
    }
    return body;
  }
}

/** Exported for tests: classify a chat/completions body. */
export function interpretCompletion(modelId: string, parsed: unknown): Omit<ProbeResult, 'latencyMs'> {
  if (typeof parsed !== 'object' || parsed === null) {
    return { modelId, ok: false, reason: 'reply was not a JSON object' };
  }
  const record = parsed as Record<string, unknown>;

  const error = record['error'];
  if (error !== undefined && error !== null) {
    const errorRecord = typeof error === 'object' ? (error as Record<string, unknown>) : {};
    const title = typeof errorRecord['title'] === 'string' ? errorRecord['title'] : undefined;
    const message = typeof errorRecord['message'] === 'string' ? errorRecord['message'] : undefined;
    const kind = typeof record['error_type'] === 'string' ? record['error_type'] : undefined;
    const reason = [title ?? message ?? (typeof error === 'string' ? error : 'gateway error'), kind]
      .filter((part): part is string => typeof part === 'string' && part !== '')
      .join(' / ');
    return { modelId, ok: false, reason: safeSnippet(reason, 120) };
  }

  const choices = record['choices'];
  if (!Array.isArray(choices) || choices.length === 0) {
    return { modelId, ok: false, reason: 'reply carried no choices' };
  }
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first ? (first['message'] as Record<string, unknown> | undefined) : undefined;
  const content = message && typeof message['content'] === 'string' ? message['content'] : '';
  const reasoning = message && typeof message['reasoning'] === 'string' ? message['reasoning'] : '';
  const finish = first && typeof first['finish_reason'] === 'string' ? first['finish_reason'] : undefined;
  // Reasoning models routinely spend the whole (tiny) budget before emitting
  // visible content: choices present means the model served the request.
  const text = content !== '' ? content : reasoning;
  const sample = text !== '' ? safeSnippet(text, 60) : `(no text, finish_reason=${finish ?? 'unknown'})`;
  return { modelId, ok: true, sample };
}
