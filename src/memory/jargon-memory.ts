import { createHash } from 'node:crypto';
import type { Logger } from '../core/logger.js';
import type { ChatMessage } from '../core/types.js';
import type { Storage, StoredRecord } from '../storage/types.js';

export type JargonStatus = 'candidate' | 'approved' | 'rejected';

export interface JargonEntry {
  kind: 'jargon-memory';
  id: string;
  term: string;
  meaning: string;
  examples: string[];
  sourceAuthors: string[];
  sharingGroup: { channelId?: string; guildId?: string };
  status: JargonStatus;
  confidence: number;
  firstSeen: number;
  lastSeen: number;
  usageCount: number;
  reviewer?: string;
  reviewedAt?: number;
}

export interface JargonFilter {
  channelId?: string;
  guildId?: string;
  status?: JargonStatus;
  limit?: number;
  offset?: number;
}

export interface JargonMemoryOptions {
  storage: Storage;
  logger: Logger;
  /** Minimum occurrences before a term becomes a candidate. Default 3. */
  minOccurrences?: number;
  /** Maximum number of examples kept per term. Default 5. */
  maxExamples?: number;
  /** Maximum approved entries returned by recall. Default 10. */
  recallLimit?: number;
  now?: () => number;
}

const PREFIX = 'jargon-memory:';
const TRACKER_PREFIX = 'jargon-tracker:';
const MAX_TERM_LENGTH = 60;
const MAX_MEANING_LENGTH = 200;
const MAX_EXAMPLE_LENGTH = 200;
const DEFAULT_MIN_OCCURRENCES = 3;
const DEFAULT_MAX_EXAMPLES = 5;
const DEFAULT_RECALL_LIMIT = 10;
const COMMON_CJK = new Set(['今天', '昨天', '明天', '大家', '一起', '继续', '还是', '然后', '因为', '所以', '可以', '这个', '那个', '什么', '怎么', '已经', '真的', '觉得', '我们', '你们', '他们', '没有', '不是', '就是', '一个', '一些', '如果', '但是', '不过', '现在', '时候', '东西', '感觉', '起来', '一下', '这里', '那里', '进行', '正在', '可能', '应该', '需要', '可以']);

/**
 * Heuristic patterns for detecting potential group jargon in messages.
 * Deliberately simple: no LLM calls. Catches:
 *  1. Quoted novel terms: 「...」 / "..." / 『...』
 *  2. Short parenthetical definitions: xxx（就是 yyy）
 *  3. Repeated non-standard tokens across messages (frequency tracked)
 */
const QUOTED_TERM = /[「『""]([^\n「」『』""]{1,40})[」』""][，,]?\s*(?:就是|指的?是|意思是|=|＝)\s*([^\n。！？!?]{1,120})/gu;
const PAREN_DEFINITION = /([\p{L}\p{N}]{2,20})[（(]\s*(?:就是|指的?是|意思是)\s*([^)）\n]{1,120})\s*[)）]/gu;

/** Internal frequency tracker for a term within a sharing group. */
interface TermTracker {
  term: string;
  count: number;
  authors: string[];
  examples: string[];
  firstSeen: number;
  lastSeen: number;
  groupKey: string;
}

function termId(term: string, groupKey: string): string {
  return createHash('sha256').update(`${groupKey}\0${term.toLocaleLowerCase()}`).digest('hex').slice(0, 32);
}

function groupKey(channelId: string, guildId?: string): string {
  return guildId ? `guild:${guildId}` : `channel:${channelId}`;
}

function clean(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/gu, ' ').trim();
}

export function validEntry(value: unknown): value is JargonEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const x = value as Partial<JargonEntry>;
  return x.kind === 'jargon-memory' && typeof x.id === 'string' &&
    typeof x.term === 'string' && x.term.length > 0 && x.term.length <= MAX_TERM_LENGTH &&
    typeof x.meaning === 'string' &&
    Array.isArray(x.examples) &&
    Array.isArray(x.sourceAuthors) &&
    typeof x.sharingGroup === 'object' && x.sharingGroup !== null &&
    ['candidate', 'approved', 'rejected'].includes(String(x.status)) &&
    typeof x.confidence === 'number' && Number.isFinite(x.confidence) &&
    Number.isFinite(x.firstSeen) && Number.isFinite(x.lastSeen) &&
    typeof x.usageCount === 'number';
}

export function buildJargonBlock(entries: readonly JargonEntry[], maxChars = 800): ChatMessage | undefined {
  const lines: string[] = [];
  let used = 0;
  for (const entry of entries) {
    const line = `- ${entry.term}：${entry.meaning}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length === 0) return undefined;
  return {
    role: 'system',
    content: '[群体黑话参考]\n以下是本群中常用的黑话/缩写/梗，仅供理解群聊语境参考，不要主动使用除非用户在用。\n' + lines.join('\n'),
  };
}

export class JargonMemory {
  readonly #storage: Storage;
  readonly #logger: Logger;
  readonly #minOccurrences: number;
  readonly #maxExamples: number;
  readonly #recallLimit: number;
  readonly #now: () => number;

  constructor(options: JargonMemoryOptions) {
    this.#storage = options.storage;
    this.#logger = options.logger.child({ component: 'jargon-memory' });
    this.#minOccurrences = Math.max(1, options.minOccurrences ?? DEFAULT_MIN_OCCURRENCES);
    this.#maxExamples = Math.max(1, options.maxExamples ?? DEFAULT_MAX_EXAMPLES);
    this.#recallLimit = Math.max(1, options.recallLimit ?? DEFAULT_RECALL_LIMIT);
    this.#now = options.now ?? Date.now;
  }

  /**
   * Scan a message for potential jargon. Explicit definitions (quoted or
   * parenthetical) are promoted immediately to candidates. Bare repeated
   * tokens are tracked and promoted once they hit `minOccurrences`.
   */
  async capture(message: {
    content: string;
    authorId: string;
    channelId: string;
    guildId?: string;
  }): Promise<void> {
    const text = clean(message.content);
    if (!text || text.length > 4000) return;
    const gk = groupKey(message.channelId, message.guildId);
    const now = this.#now();

    // 1. Explicit definitions via quotes or parentheses
    for (const pattern of [QUOTED_TERM, PAREN_DEFINITION]) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        const term = clean(match[1] ?? '');
        const meaning = clean(match[2] ?? '');
        if (!term || term.length > MAX_TERM_LENGTH || !meaning || meaning.length > MAX_MEANING_LENGTH) continue;
        await this.#upsertCandidate(term, meaning, text, message.authorId, message.channelId, message.guildId, gk, now);
      }
    }

    // 2. Frequency-based detection: track short non-standard tokens
    const tokens = this.#extractTokens(text);
    for (const token of tokens) {
      await this.#trackToken(token, text, message.authorId, message.channelId, message.guildId, gk, now);
    }
  }

  async approve(termId: string, reviewer: string): Promise<'applied' | 'unchanged' | 'not-found'> {
    const key = `${PREFIX}${termId}`;
    const existing = await this.#storage.get<unknown>(key);
    if (!validEntry(existing)) return 'not-found';
    if (existing.status === 'approved') return 'unchanged';
    const updated: JargonEntry = { ...existing, status: 'approved', reviewer, reviewedAt: this.#now() };
    await this.#storage.save(key, updated);
    this.#logger.info({ termId, reviewer }, 'jargon approved');
    return 'applied';
  }

  async reject(termId: string, reviewer: string): Promise<'applied' | 'unchanged' | 'not-found'> {
    const key = `${PREFIX}${termId}`;
    const existing = await this.#storage.get<unknown>(key);
    if (!validEntry(existing)) return 'not-found';
    if (existing.status === 'rejected') return 'unchanged';
    const updated: JargonEntry = { ...existing, status: 'rejected', reviewer, reviewedAt: this.#now() };
    await this.#storage.save(key, updated);
    this.#logger.info({ termId, reviewer }, 'jargon rejected');
    return 'applied';
  }

  /**
   * Recall approved jargon entries for a channel (or its guild).
   * Returns entries sorted by usage count, limited by recallLimit.
   */
  async recall(channelId: string, guildId?: string, limit?: number): Promise<JargonEntry[]> {
    const effectiveLimit = Math.max(1, Math.min(limit ?? this.#recallLimit, 50));
    const rows = await this.#storage.query<unknown>({ prefix: PREFIX, limit: 500 });
    const gk = groupKey(channelId, guildId);
    return rows
      .map((row) => row.value)
      .filter(validEntry)
      .filter((entry) => entry.status === 'approved' && groupKey(entry.sharingGroup.channelId ?? channelId, entry.sharingGroup.guildId) === gk)
      .sort((a, b) => b.usageCount - a.usageCount || b.lastSeen - a.lastSeen)
      .slice(0, effectiveLimit);
  }

  async list(filter?: JargonFilter): Promise<JargonEntry[]> {
    const rows = await this.#storage.query<unknown>({ prefix: PREFIX, limit: 1000 });
    let entries = rows.map((row) => row.value).filter(validEntry);
    if (filter?.status) entries = entries.filter((e) => e.status === filter.status);
    if (filter?.channelId) entries = entries.filter((e) => e.sharingGroup.channelId === filter.channelId);
    if (filter?.guildId) entries = entries.filter((e) => e.sharingGroup.guildId === filter.guildId);
    entries.sort((a, b) => b.lastSeen - a.lastSeen);
    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? 100;
    return entries.slice(offset, offset + limit);
  }

  async #upsertCandidate(
    term: string, meaning: string, example: string,
    authorId: string, channelId: string, guildId: string | undefined,
    gk: string, now: number,
  ): Promise<void> {
    const id = termId(term, gk);
    const key = `${PREFIX}${id}`;
    const existing = await this.#storage.get<unknown>(key);
    if (validEntry(existing)) {
      const authors = existing.sourceAuthors.includes(authorId) ? existing.sourceAuthors : [...existing.sourceAuthors, authorId].slice(0, 20);
      const examples = existing.examples.includes(example.slice(0, MAX_EXAMPLE_LENGTH))
        ? existing.examples
        : [...existing.examples, example.slice(0, MAX_EXAMPLE_LENGTH)].slice(-this.#maxExamples);
      const updated: JargonEntry = {
        ...existing,
        meaning: meaning || existing.meaning,
        examples,
        sourceAuthors: authors,
        lastSeen: now,
        usageCount: existing.usageCount + 1,
        confidence: Math.min(1, existing.confidence + 0.05),
      };
      await this.#storage.save(key, updated);
      return;
    }
    const entry: JargonEntry = {
      kind: 'jargon-memory',
      id,
      term,
      meaning,
      examples: [example.slice(0, MAX_EXAMPLE_LENGTH)],
      sourceAuthors: [authorId],
      sharingGroup: { channelId, guildId },
      status: 'candidate',
      confidence: 0.5,
      firstSeen: now,
      lastSeen: now,
      usageCount: 1,
    };
    await this.#storage.save(key, entry);
    this.#logger.debug({ term, id }, 'jargon candidate created from definition');
  }

  /**
   * Extract short non-standard tokens that may be jargon.
   * Selects CJK-heavy or mixed alpha-CJK tokens of 2-8 chars that are
   * not common dictionary words. Very conservative: false negatives are
   * acceptable; false positives are not.
   */
  #extractTokens(text: string): string[] {
    const tokenPattern = /(?:[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2,8}|[A-Za-z0-9]{2,12}(?:[\p{Script=Han}]+)?)/gu;
    const matches = text.match(tokenPattern) ?? [];
    // Deduplicate, lower-case, filter very short
    const seen = new Set<string>();
    const result: string[] = [];
    for (const raw of matches) {
      const token = raw.toLocaleLowerCase();
      if (token.length < 2 || seen.has(token)) continue;
      seen.add(token);
      result.push(token);
      // Chinese messages are not whitespace-tokenized. Add overlapping
      // bigrams from Han runs so short expressions (e.g. 摆烂) are trackable
      // even when surrounded by prose. Candidate promotion still requires
      // repeated use by multiple authors.
      if (/^[\p{Script=Han}]{4,}$/u.test(raw)) {
        for (let i = 0; i <= raw.length - 2; i += 1) {
          const part = raw.slice(i, i + 2);
          if (COMMON_CJK.has(part) || seen.has(part)) continue;
          seen.add(part);
          result.push(part);
        }
      }
    }
    return result;
  }

  async #trackToken(
    token: string, example: string,
    authorId: string, channelId: string, guildId: string | undefined,
    gk: string, now: number,
  ): Promise<void> {
    const trackerKey = `${TRACKER_PREFIX}${gk}:${token}`;
    const existing = await this.#storage.get<TermTracker>(trackerKey);
    const tracker: TermTracker = existing && typeof existing === 'object' && 'count' in existing
      ? {
          ...existing,
          count: existing.count + 1,
          authors: existing.authors.includes(authorId) ? existing.authors : [...existing.authors, authorId].slice(0, 20),
          examples: existing.examples.length < this.#maxExamples
            ? [...existing.examples, example.slice(0, MAX_EXAMPLE_LENGTH)]
            : existing.examples,
          lastSeen: now,
          groupKey: gk,
        }
      : {
          term: token,
          count: 1,
          authors: [authorId],
          examples: [example.slice(0, MAX_EXAMPLE_LENGTH)],
          firstSeen: now,
          lastSeen: now,
          groupKey: gk,
        };
    // 30-day TTL on trackers
    await this.#storage.save(trackerKey, tracker, 30 * 86400);

    // Promote to candidate when threshold met by multiple authors
    if (tracker.count >= this.#minOccurrences && tracker.authors.length >= 2) {
      const id = termId(token, gk);
      const entryKey = `${PREFIX}${id}`;
      const existingEntry = await this.#storage.get<unknown>(entryKey);
      if (!validEntry(existingEntry)) {
        const entry: JargonEntry = {
          kind: 'jargon-memory',
          id,
          term: token,
          meaning: '',
          examples: tracker.examples.slice(-this.#maxExamples),
          sourceAuthors: tracker.authors,
          sharingGroup: { channelId, guildId },
          status: 'candidate',
          confidence: 0.3,
          firstSeen: tracker.firstSeen,
          lastSeen: now,
          usageCount: tracker.count,
        };
        await this.#storage.save(entryKey, entry);
        this.#logger.debug({ term: token, id, count: tracker.count }, 'jargon candidate promoted from frequency');
      } else {
        // Update usage count on existing entry
        const updated: JargonEntry = {
          ...existingEntry,
          lastSeen: now,
          usageCount: existingEntry.usageCount + 1,
          sourceAuthors: tracker.authors.length > existingEntry.sourceAuthors.length ? tracker.authors : existingEntry.sourceAuthors,
        };
        await this.#storage.save(entryKey, updated);
      }
    }
  }
}

export { PREFIX as JARGON_MEMORY_PREFIX };
