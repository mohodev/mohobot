import type { Logger } from '../core/logger.js';
import type { RerankProvider } from '../memory/semantic-memory.js';

export interface RerankConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs?: number;
}

interface RerankResponseItem {
  index?: unknown;
  relevance_score?: unknown;
  score?: unknown;
}

/**
 * OpenAI-compatible rerank client.
 *
 * Provider errors and malformed responses are intentionally propagated. The
 * semantic-memory caller owns fallback to embedding/keyword ordering.
 */
export class OpenAIRerankProvider implements RerankProvider {
  readonly name = 'openai-compatible-rerank';
  readonly #config: RerankConfig;
  readonly #logger: Logger;

  constructor(config: RerankConfig, logger: Logger) {
    this.#config = config;
    this.#logger = logger.child({ component: 'rerank', model: config.model });
  }

  async rerank(input: {
    query: string;
    documents: string[];
    topK: number;
  }): Promise<Array<{ index: number; score: number }>> {
    if (!input.query.trim()) throw new Error('rerank query must not be empty');
    if (input.documents.length === 0) return [];

    const topN = Math.max(1, Math.min(input.documents.length, Math.floor(input.topK)));
    const controller = new AbortController();
    const timeoutMs = this.#config.timeoutMs ?? 20_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${this.#config.baseUrl.replace(/\/$/, '')}/rerank`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.#config.apiKey ? { authorization: `Bearer ${this.#config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.#config.model,
          query: input.query,
          documents: input.documents,
          top_n: topN,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`rerank request failed: HTTP ${response.status}`);
      }

      const payload = await response.json() as {
        results?: unknown;
        data?: unknown;
      };
      const raw = Array.isArray(payload.results)
        ? payload.results
        : Array.isArray(payload.data)
          ? payload.data
          : undefined;
      if (!raw) throw new Error('rerank response is missing results');

      const seen = new Set<number>();
      const output = raw.map((value, position) => {
        if (!value || typeof value !== 'object') {
          throw new Error(`rerank result ${position} is not an object`);
        }
        const item = value as RerankResponseItem;
        const index = item.index;
        const score = item.relevance_score ?? item.score;
        if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= input.documents.length) {
          throw new Error(`rerank result ${position} has an invalid index`);
        }
        if (typeof score !== 'number' || !Number.isFinite(score)) {
          throw new Error(`rerank result ${position} has an invalid score`);
        }
        if (seen.has(index as number)) {
          throw new Error(`rerank response contains duplicate index ${index}`);
        }
        seen.add(index as number);
        return { index: index as number, score };
      });

      if (output.length > topN) throw new Error('rerank response exceeds requested top_n');
      return output;
    } catch (error) {
      this.#logger.debug({ err: error }, 'rerank request failed');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
