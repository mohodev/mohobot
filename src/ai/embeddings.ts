import type { Logger } from '../core/logger.js';
import { runtimeMetrics } from '../core/runtime-metrics.js';

export interface EmbeddingProvider { readonly name: string; readonly model: string; embed(input: string | string[], options?: { timeoutMs?: number }): Promise<number[][]>; }
export interface EmbeddingConfig { baseUrl: string; apiKey: string; model: string; timeoutMs?: number; }

/** OpenAI-compatible embeddings client. It is optional and never on the reply hot path. */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai-compatible-embedding';
  readonly #cfg: EmbeddingConfig;
  readonly #logger: Logger;
  constructor(cfg: EmbeddingConfig, logger: Logger) { this.#cfg = cfg; this.#logger = logger.child({ component: 'embedding', model: cfg.model }); }
  get model(): string { return this.#cfg.model; }
  async embed(input: string | string[], options: { timeoutMs?: number } = {}): Promise<number[][]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? this.#cfg.timeoutMs ?? 20_000);
    const started=Date.now();
    try {
      const response = await fetch(`${this.#cfg.baseUrl.replace(/\/$/, '')}/embeddings`, { method: 'POST', headers: { 'content-type': 'application/json', ...(this.#cfg.apiKey ? { authorization: `Bearer ${this.#cfg.apiKey}` } : {}) }, body: JSON.stringify({ model: this.#cfg.model, input }), signal: controller.signal });
      if (!response.ok) throw new Error(`embedding request failed: HTTP ${response.status}`);
      const payload = await response.json() as { data?: Array<{ embedding?: unknown; index?: number }> };
      const rows = (payload.data ?? []).sort((a,b)=>(a.index ?? 0)-(b.index ?? 0));
      if (!rows.length || rows.some((row) => !Array.isArray(row.embedding) || row.embedding.some((value) => typeof value !== 'number'))) throw new Error('embedding response has invalid vectors');
      runtimeMetrics.embedding.record(Date.now()-started,true);
      return rows.map((row) => row.embedding as number[]);
    } catch (error) { runtimeMetrics.embedding.record(Date.now()-started,false);this.#logger.debug({ err: error }, 'embedding request failed'); throw error; }
    finally { clearTimeout(timer); }
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot=0, aa=0, bb=0; for(let i=0;i<a.length;i+=1){dot+=a[i]! * b[i]!;aa+=a[i]!**2;bb+=b[i]!**2;}
  return aa === 0 || bb === 0 ? 0 : dot / Math.sqrt(aa * bb);
}

export interface SemanticItem<T> { id: string; text: string; value: T; vector?: number[]; }
export async function semanticTopK<T>(provider: EmbeddingProvider, query: string, items: SemanticItem<T>[], k=5): Promise<Array<SemanticItem<T> & { score: number }>> {
  if (!items.length) return [];
  const queryVector = (await provider.embed(query))[0]!;
  const missing = items.filter((item) => !item.vector);
  if (missing.length) {
    const vectors = await provider.embed(missing.map((item) => item.text));
    missing.forEach((item,index)=>{ item.vector = vectors[index]; });
  }
  return items.map((item)=>({ ...item, score: cosineSimilarity(queryVector, item.vector!) })).sort((a,b)=>b.score-a.score).slice(0,k);
}
