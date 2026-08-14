import type { Logger } from '../core/logger.js';
import type { ChatMessage } from '../core/types.js';
import type { MemoryAdapter, Storage, StoredRecord } from '../storage/types.js';

export type MemoryScope = 'private' | 'relationship' | 'shared';

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  embed(input: string | string[]): Promise<number[][]>;
}

export interface RerankProvider {
  readonly name: string;
  rerank(input: { query: string; documents: string[]; topK: number }): Promise<Array<{ index: number; score: number }>>;
}

export interface SemanticMemoryRecord {
  id: string;
  botId: string;
  channelId: string;
  userId: string;
  scope: MemoryScope;
  text: string;
  user: ChatMessage;
  assistant: ChatMessage;
  createdAt: number;
  /** Optional derived index. `text` and messages remain the source of truth. */
  vector?: number[];
  embeddingModel?: string;
}

export interface SemanticMemoryOptions {
  storage: Storage;
  logger: Logger;
  embedding?: EmbeddingProvider;
  reranker?: RerankProvider;
  recallLimit?: number;
  candidateLimit?: number;
  embeddingBatchSize?: number;
  scopeForExchange?: (input: Parameters<MemoryAdapter['remember']>[0]) => MemoryScope;
  allowedScopes?: (input: Parameters<MemoryAdapter['recall']>[0]) => readonly MemoryScope[];
  /** Maps a channel to an authorization domain such as `dm:<id>` or `guild:<id>`. */
  channelDomain?: (channelId: string) => string;
  /** Injectable monotonic clock for deterministic tests and clustered nodes. */
  now?: () => number;
}

const PREFIX = 'semantic-memory:';
const ALL_SCOPES: readonly MemoryScope[] = ['private', 'relationship', 'shared'];

function words(value: string): Set<string> {
  return new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

function keywordScore(query: string, text: string): number {
  const queryWords = words(query);
  if (queryWords.size === 0) return 0;
  const textWords = words(text);
  let matches = 0;
  for (const word of queryWords) if (textWords.has(word)) matches += 1;
  return matches / queryWords.size;
}

function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index]! * b[index]!;
    aa += a[index]! ** 2;
    bb += b[index]! ** 2;
  }
  return aa === 0 || bb === 0 ? 0 : dot / Math.sqrt(aa * bb);
}

function chunks<T>(items: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
}

/**
 * Storage-backed memory with optional semantic indexes.
 *
 * Records are persisted before any embedding request. Vectors are disposable
 * derived data: an unavailable provider never loses or hides the source text.
 */
export class SemanticMemoryAdapter implements MemoryAdapter {
  readonly name = 'semantic';
  readonly #storage: Storage;
  readonly #logger: Logger;
  readonly #embedding?: EmbeddingProvider;
  readonly #reranker?: RerankProvider;
  readonly #recallLimit: number;
  readonly #candidateLimit: number;
  readonly #embeddingBatchSize: number;
  readonly #scopeForExchange: NonNullable<SemanticMemoryOptions['scopeForExchange']>;
  readonly #allowedScopes: NonNullable<SemanticMemoryOptions['allowedScopes']>;
  readonly #crossChannelScopeAuthorized:boolean;
  readonly #channelDomain: NonNullable<SemanticMemoryOptions['channelDomain']>;
  readonly #now: () => number;

  constructor(options: SemanticMemoryOptions) {
    this.#storage = options.storage;
    this.#logger = options.logger.child({ component: 'semantic-memory' });
    this.#embedding = options.embedding;
    this.#reranker = options.reranker;
    this.#recallLimit = Math.max(1, options.recallLimit ?? 5);
    this.#candidateLimit = Math.max(this.#recallLimit, options.candidateLimit ?? 30);
    this.#embeddingBatchSize = Math.max(1, options.embeddingBatchSize ?? 16);
    this.#scopeForExchange = options.scopeForExchange ?? (() => 'private');
    this.#allowedScopes = options.allowedScopes ?? (() => ALL_SCOPES);
    this.#crossChannelScopeAuthorized=options.allowedScopes!==undefined;
    this.#channelDomain = options.channelDomain ?? ((channelId) => `channel:${channelId}`);
    this.#now = options.now ?? Date.now;
  }

  async remember(input: Parameters<MemoryAdapter['remember']>[0]): Promise<void> {
    const createdAt = this.#now();
    const id = `${createdAt}-${Math.random().toString(36).slice(2, 10)}`;
    const record: SemanticMemoryRecord = {
      id,
      botId: input.botId,
      channelId: input.channelId,
      userId: input.userId,
      scope: this.#scopeForExchange(input),
      text: `User: ${input.user.content}\nAssistant: ${input.assistant.content}`,
      user: input.user,
      assistant: input.assistant,
      createdAt,
    };
    const key = this.#key(record);

    // Source text is durable before optional indexing starts.
    await this.#storage.save(key, record);
    if (!this.#embedding) return;

    try {
      const [vector] = await this.#embedding.embed([record.text]);
      if (!vector?.length) throw new Error('embedding provider returned no vector');
      await this.#storage.save(key, { ...record, vector, embeddingModel: this.#embedding.model });
    } catch (error) {
      this.#logger.warn({ err: error, key }, 'memory saved without embedding');
    }
  }

  async recall(input: Parameters<MemoryAdapter['recall']>[0]): Promise<ChatMessage[]> {
    const allowed = new Set(this.#allowedScopes(input));
    const records = await this.#storage.query<SemanticMemoryRecord>({
      prefix: `${PREFIX}${input.botId}:`,
      limit: this.#candidateLimit * 4,
    });
    const targetDomain = this.#channelDomain(input.channelId);
    const visible = records
      .filter(({ value }) => {
        if (value.userId !== input.userId || !allowed.has(value.scope)) return false;
        if (value.channelId === input.channelId) return true;
        if (value.scope !== 'shared' || !this.#crossChannelScopeAuthorized) return false;
        return this.#channelDomain(value.channelId) === targetDomain;
      })
      .sort((a, b) => b.value.createdAt - a.value.createdAt)
      .slice(0, this.#candidateLimit);

    if (visible.length === 0) return [];
    const ranked = await this.#rank(input.query, visible);
    return ranked.slice(0, this.#recallLimit).map(({ value }) => ({
      role: 'system',
      content: `[Recalled ${value.scope} memory]\n${value.text}`,
      createdAt: value.createdAt,
    }));
  }

  async #rank(query: string, records: StoredRecord<SemanticMemoryRecord>[]): Promise<StoredRecord<SemanticMemoryRecord>[]> {
    let candidates = records;
    if (this.#embedding) {
      try {
        candidates = await this.#semanticCandidates(query, records);
      } catch (error) {
        this.#logger.warn({ err: error }, 'semantic recall failed; using keyword and recency fallback');
        candidates = this.#keywordCandidates(query, records);
      }
    } else {
      candidates = this.#keywordCandidates(query, records);
    }

    if (!this.#reranker || candidates.length < 2) return candidates;
    try {
      const order = await this.#reranker.rerank({
        query,
        documents: candidates.map(({ value }) => value.text),
        topK: this.#recallLimit,
      });
      const valid = order.filter(({ index }) => Number.isInteger(index) && index >= 0 && index < candidates.length);
      return valid.length > 0 ? valid.map(({ index }) => candidates[index]!) : candidates;
    } catch (error) {
      this.#logger.warn({ err: error }, 'memory rerank failed; keeping semantic order');
      return candidates;
    }
  }

  async #semanticCandidates(query: string, records: StoredRecord<SemanticMemoryRecord>[]): Promise<StoredRecord<SemanticMemoryRecord>[]> {
    const [queryVector] = await this.#embedding!.embed([query]);
    if (!queryVector?.length) throw new Error('embedding provider returned no query vector');
    const missing = records.filter(({ value }) => !value.vector?.length || value.embeddingModel !== this.#embedding!.model);

    for (const batch of chunks(missing, this.#embeddingBatchSize)) {
      const vectors = await this.#embedding!.embed(batch.map(({ value }) => value.text));
      if (vectors.length !== batch.length) throw new Error('embedding batch size mismatch');
      await Promise.all(batch.map(async (stored, index) => {
        const vector = vectors[index];
        if (!vector?.length) throw new Error('embedding provider returned an empty vector');
        stored.value = { ...stored.value, vector, embeddingModel: this.#embedding!.model };
        await this.#storage.save(stored.key, stored.value);
      }));
    }

    return records
      .map((record) => ({ record, score: cosine(queryVector, record.value.vector ?? []) }))
      .sort((a, b) => b.score - a.score || b.record.value.createdAt - a.record.value.createdAt)
      .map(({ record }) => record);
  }

  #keywordCandidates(query: string, records: StoredRecord<SemanticMemoryRecord>[]): StoredRecord<SemanticMemoryRecord>[] {
    return records
      .map((record) => ({ record, score: keywordScore(query, record.value.text) }))
      .sort((a, b) => b.score - a.score || b.record.value.createdAt - a.record.value.createdAt)
      .map(({ record }) => record);
  }

  #key(record: SemanticMemoryRecord): string {
    return `${PREFIX}${record.botId}:${record.userId}:${record.createdAt}:${record.id}`;
  }
}
