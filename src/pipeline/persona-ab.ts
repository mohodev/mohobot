/**
 * Single-turn private persona A/B evaluation.
 *
 * Ported from carefreesongs712/mohobot `mohobot/services/persona_ab.py` and
 * `persona_ab_repository.py`: a DM is occasionally answered twice with the same
 * prepared input and the same model parameters, swapping only the persona
 * system prompt, and the user votes anonymously on A or B. This is how a prompt
 * beta gets tested against the shipped baseline in production.
 *
 * The rules that make the numbers mean anything, all preserved from upstream:
 *  - both candidates see the *same* input and parameters; only the persona differs
 *  - A/B are shuffled per record, so position never correlates with the winner
 *  - only a confirmed delivery counts as an exposure; a failed card is a
 *    fallback text delivery, never a counted comparison
 *  - the chat reply keeps the persona the user would normally have got, so an
 *    evaluation never disturbs the ongoing conversation
 *  - voting never switches the persona by itself
 *  - one active evaluation per user, a cooldown, dedupe by source message
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export type AbSide = 'baseline' | 'test';
export const AB_VOTES = ['A', 'B', '平局', '都不好', '跳过'] as const;
export type AbVote = (typeof AB_VOTES)[number];

export interface PersonaSnapshot {
  /** Stable id: the prompt file path, or 'inline'. */
  id: string;
  label: string;
  content: string;
  hash: string;
}

export interface PersonaAbRecord {
  id: string;
  botId: string;
  userId: string;
  sourceMessageId: string;
  /** Which side the normal chat reply used, so the flow is undisturbed. */
  contextSide: AbSide;
  personas: Record<AbSide, PersonaSnapshot>;
  /** Which side landed on card slot A vs B (shuffled per record). */
  mapping: { A: AbSide; B: AbSide };
  createdAt: number;
  expiresAt: number;
  state: 'generating' | 'sending' | 'pending' | 'voted' | 'expired' | 'failed' | 'aborted' | 'fallback';
  candidates: Partial<Record<AbSide, string>>;
  generationErrors: Partial<Record<AbSide, string>>;
  vote: AbVote | null;
  votedAt: number | null;
  switch: { choice: 'A' | 'B'; at: number; side: AbSide } | null;
  exposedAt: number | null;
  endedAt: number | null;
  delivery: 'images' | 'text' | 'failed' | 'unknown' | null;
}

interface StoreFile {
  version: 1;
  cooldownUntil: number;
  active: string | null;
  records: PersonaAbRecord[];
}

export interface PersonaAbConfig {
  enabled: boolean;
  baselinePromptFile?: string;
  testPromptFile?: string;
  probability: number;
  cooldownSeconds: number;
  pendingSeconds: number;
}

export const DEFAULT_PERSONA_AB_CONFIG: PersonaAbConfig = {
  enabled: false,
  probability: 0.05,
  cooldownSeconds: 900,
  pendingSeconds: 86_400,
};

const ACTIVE_STATES = new Set(['generating', 'sending', 'pending']);
const MAX_RECORDS = 200;

function contentHash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function randomId(): string {
  return crypto.randomBytes(8).toString('hex');
}

/** Per-bot/user JSON store; atomic via write-temp + rename. */
export class PersonaAbRepository {
  readonly #root: string;
  readonly #now: () => number;

  constructor(rootDir: string, now: () => number = Date.now) {
    this.#root = path.join(rootDir, 'data', 'persona-ab');
    this.#now = now;
  }

  #file(botId: string, userId: string): string {
    return path.join(this.#root, botId, `${userId}.json`);
  }

  async #load(botId: string, userId: string): Promise<StoreFile> {
    const empty: StoreFile = { version: 1, cooldownUntil: 0, active: null, records: [] };
    try {
      const raw = await fs.readFile(this.#file(botId, userId), 'utf8');
      const parsed = JSON.parse(raw) as StoreFile;
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.records)) return empty;
      return { version: 1, cooldownUntil: parsed.cooldownUntil ?? 0, active: parsed.active ?? null, records: parsed.records };
    } catch {
      return empty;
    }
  }

  async #save(botId: string, userId: string, data: StoreFile): Promise<void> {
    const file = this.#file(botId, userId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, file);
  }

  /** Expiry + active cleanup. Public: the service runs it inside transactions. */
  expire(data: StoreFile): void {
    const now = this.#now();
    for (const record of data.records) {
      if (record.state === 'pending' && now >= record.expiresAt) {
        record.state = 'expired';
        record.endedAt = now;
      }
    }
    if (data.active && !data.records.some((record) => record.id === data.active && ACTIVE_STATES.has(record.state))) {
      data.active = null;
    }
  }

  /** One synchronous mutation per transaction: no IO or model calls inside. */
  async transaction(botId: string, userId: string, mutate: (data: StoreFile) => unknown): Promise<unknown> {
    const data = await this.#load(botId, userId);
    const result = mutate(data);
    await this.#save(botId, userId, data);
    return result;
  }

  async update(botId: string, userId: string, id: string, changes: Partial<PersonaAbRecord>): Promise<void> {
    await this.transaction(botId, userId, (data) => {
      const record = data.records.find((entry) => entry.id === id);
      if (!record) return;
      Object.assign(record, changes);
      if (!ACTIVE_STATES.has(record.state) && data.active === id) data.active = null;
      if (data.records.length > MAX_RECORDS) data.records.splice(0, data.records.length - MAX_RECORDS);
    });
  }

  /** Startup repair: interrupted work must never look like a live evaluation. */
  async recover(botId: string): Promise<number> {
    const dir = path.join(this.#root, botId);
    let repaired = 0;
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return 0;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const userId = entry.slice(0, -5);
      await this.transaction(botId, userId, (data) => {
        for (const record of data.records) {
          if (record.state === 'generating') { record.state = 'aborted'; record.endedAt = this.#now(); repaired += 1; }
          else if (record.state === 'sending') { record.state = 'aborted'; record.endedAt = this.#now(); repaired += 1; }
        }
        this.expire(data);
      });
    }
    return repaired;
  }

  async allRecords(botId: string): Promise<PersonaAbRecord[]> {
    const dir = path.join(this.#root, botId);
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return [];
    }
    const records: PersonaAbRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      await this.transaction(botId, entry.slice(0, -5), (data) => {
        this.expire(data);
        records.push(...data.records);
      });
    }
    return records.sort((a, b) => b.createdAt - a.createdAt);
  }
}

export interface PersonaAbDeps {
  rootDir: string;
  botId: string;
  config: PersonaAbConfig;
  /** Resolves a prompt file (relative to the project root) to its text. */
  loadPrompt: (file: string) => Promise<string>;
  /**
   * Default sender (notice + card + fallback). The caller may override it per
   * evaluation so the card lands in the right DM channel.
   */
  send: (content: string) => Promise<boolean>;
  now?: () => number;
  /** Injectable shuffle for tests. */
  shuffle?: <T>(items: T[]) => T[];
  /** Injectable sampler for tests. */
  random?: () => number;
}

export interface AbEvaluateOptions {
  /** Channel-bound sender; defaults to the deps-level sender. Never throws. */
  send?: (content: string) => Promise<boolean>;
  /** When true, nothing more is sent and the outcome is flagged aborted. */
  shouldAbort?: () => boolean;
}

export interface AbEvaluationOutcome {
  /** Reply text to continue the chat with (the user's normal persona). */
  reply: string;
  /** true when a full A/B card was delivered and the exposure counts. */
  exposed: boolean;
  /** true when a newer message superseded the turn; the reply must be dropped. */
  aborted: boolean;
}

export interface PersonaAbStats {
  shown: number;
  votes: number;
  baselineWins: number;
  testWins: number;
  ties: number;
  bothBad: number;
  skipped: number;
  expired: number;
  failed: number;
  responseRate: number;
  notice: string;
}

const AB_NOTICE = [
  '你好呀！提前跟你说一声，接下来会一个小环节想邀请你参与～',
  '我会展示两组回复（A 和 B），你可以比较一下。本轮的对话内容、两版回答以及你的反馈都会被记录下来，只用于改进人设提示词。',
  '你完全可以继续正常跟我聊天，不用有任何顾虑。想表达偏好时随时发 `?ab A` 或 `?ab B` 投票就好——投票不会自动切换我的人设，一切由你掌控。',
].join('\n');

export class PersonaAbService {
  readonly #repo: PersonaAbRepository;
  readonly #deps: PersonaAbDeps;
  readonly #now: () => number;
  readonly #shuffle: <T>(items: T[]) => T[];
  readonly #random: () => number;

  constructor(deps: PersonaAbDeps) {
    this.#deps = deps;
    this.#repo = new PersonaAbRepository(deps.rootDir, deps.now ?? Date.now);
    this.#now = deps.now ?? Date.now;
    this.#shuffle = deps.shuffle ?? (<T>(items: T[]): T[] => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    });
    this.#random = deps.random ?? Math.random;
  }

  get config(): PersonaAbConfig { return { ...DEFAULT_PERSONA_AB_CONFIG, ...this.#deps.config }; }

  /** Startup repair: interrupted work must never look like a live evaluation. */
  async recover(): Promise<number> {
    return this.#repo.recover(this.#deps.botId);
  }

  /** A side's persona text. Falls back to the bot's own prompt when unset. */
  async snapshot(side: AbSide, fallbackContent: string, fallbackLabel: string): Promise<PersonaSnapshot> {
    const file = side === 'baseline' ? this.config.baselinePromptFile : this.config.testPromptFile;
    if (file) {
      const content = await this.#deps.loadPrompt(file);
      return { id: file, label: path.basename(file), content, hash: contentHash(content) };
    }
    return { id: 'inline', label: fallbackLabel, content: fallbackContent, hash: contentHash(fallbackContent) };
  }

  /** Sampling gate. DMs only: one active record, a cooldown and message dedupe. */
  async reserve(input: {
    userId: string;
    sourceMessageId: string;
    contextSide: AbSide;
    baseline: PersonaSnapshot;
    test: PersonaSnapshot;
  }): Promise<PersonaAbRecord | null> {
    const config = this.config;
    if (!config.enabled) return null;
    // Identical prompts can never produce a meaningful comparison.
    if (input.baseline.hash === input.test.hash) return null;

    const now = this.#now();
    const created = await this.#repo.transaction(this.#deps.botId, input.userId, (data) => {
      this.#repo.expire(data);
      if (data.active) return null;
      if (now < data.cooldownUntil) return null;
      if (input.sourceMessageId && data.records.some((record) => record.sourceMessageId === input.sourceMessageId)) return null;
      if (this.#random() >= config.probability) return null;

      const sides = this.#shuffle<AbSide>(['baseline', 'test']);
      const record: PersonaAbRecord = {
        id: randomId(),
        botId: this.#deps.botId,
        userId: input.userId,
        sourceMessageId: input.sourceMessageId,
        contextSide: input.contextSide,
        personas: { baseline: input.baseline, test: input.test },
        mapping: { A: sides[0]!, B: sides[1]! },
        createdAt: now,
        expiresAt: now + config.pendingSeconds * 1000,
        state: 'generating',
        candidates: {},
        generationErrors: {},
        vote: null,
        votedAt: null,
        switch: null,
        exposedAt: null,
        endedAt: null,
        delivery: null,
      };
      data.records.push(record);
      data.active = record.id;
      data.cooldownUntil = now + config.cooldownSeconds * 1000;
      return record;
    });
    return (created as PersonaAbRecord | null) ?? null;
  }

  /**
   * Generate both sides from the *same* prepared input and deliver the card.
   * `generate` receives only the persona text, so the caller owns the rest of
   * the prompt and the model parameters - that is what keeps the comparison fair.
   * `shouldAbort` lets the caller cancel a superseded turn: nothing is sent and
   * the reply comes back flagged aborted so the pipeline drops it silently.
   */
  async evaluate(
    record: PersonaAbRecord,
    generate: (personaContent: string) => Promise<string>,
    opts: AbEvaluateOptions = {},
  ): Promise<AbEvaluationOutcome> {
    const aborted = opts.shouldAbort ?? (() => false);
    const send = async (content: string): Promise<boolean> => {
      try {
        return await (opts.send ?? this.#deps.send)(content);
      } catch {
        return false;
      }
    };
    const candidates: Partial<Record<AbSide, string>> = {};
    const errors: Partial<Record<AbSide, string>> = {};
    const settled = await Promise.allSettled([
      generate(record.personas.baseline!.content).then((text) => { candidates.baseline = text; }),
      generate(record.personas.test!.content).then((text) => { candidates.test = text; }),
    ]);
    for (const [index, result] of settled.entries()) {
      if (result.status === 'rejected') {
        const side: AbSide = index === 0 ? 'baseline' : 'test';
        errors[side] = result.reason instanceof Error ? result.reason.name : 'Error';
      }
    }
    await this.#repo.update(record.botId, record.userId, record.id, { candidates, generationErrors: errors });

    const both = candidates.baseline !== undefined && candidates.test !== undefined;
    if (aborted()) {
      const now = this.#now();
      await this.#repo.update(record.botId, record.userId, record.id, { candidates, generationErrors: errors, state: 'aborted', endedAt: now });
      return { reply: '', exposed: false, aborted: true };
    }
    const noticeDelivered = both ? await send(AB_NOTICE) : false;
    if (both && noticeDelivered) {
      const card = [
        `🧪 人设对比（编号 ${record.id}）`,
        `**回复 A**（${record.personas[record.mapping.A]!.label}）`,
        candidates[record.mapping.A]!,
        `**回复 B**（${record.personas[record.mapping.B]!.label}）`,
        candidates[record.mapping.B]!,
        '更喜欢哪一边？`?ab A` / `?ab B` / `?ab 平局` / `?ab 都不好` / `?ab 跳过`',
      ].join('\n');
      const exposed = await send(card);
      if (exposed) {
        const now = this.#now();
        await this.#repo.update(record.botId, record.userId, record.id, {
          state: 'pending', exposedAt: now, delivery: 'text',
        });
        return { reply: candidates[record.contextSide] ?? '', exposed: true, aborted: false };
      }
      await this.#repo.update(record.botId, record.userId, record.id, { state: 'sending' });
    }

    // Controlled fallback: one retry for the side the chat would have used, so a
    // broken evaluation costs the user their normal answer at worst.
    const side = record.contextSide;
    if (aborted()) {
      const now = this.#now();
      await this.#repo.update(record.botId, record.userId, record.id, { candidates, generationErrors: errors, state: 'aborted', endedAt: now });
      return { reply: '', exposed: false, aborted: true };
    }
    if (candidates[side] === undefined) {
      try {
        candidates[side] = await generate(record.personas[side]!.content);
      } catch (error) {
        errors[side] = error instanceof Error ? error.name : 'Error';
        await this.#repo.update(record.botId, record.userId, record.id, { candidates, generationErrors: errors });
        if (!aborted()) {
          await send('本轮评估未能完成，未记录错误内容为聊天答案。请稍后继续聊天。');
        }
        const now = this.#now();
        await this.#repo.update(record.botId, record.userId, record.id, { state: aborted() ? 'aborted' : 'failed', endedAt: now, delivery: 'failed' });
        return { reply: '', exposed: false, aborted: aborted() };
      }
    }
    const delivered = await send(candidates[side]!);
    const now = this.#now();
    const wasAborted = aborted();
    await this.#repo.update(record.botId, record.userId, record.id, {
      candidates, generationErrors: errors,
      state: wasAborted ? 'aborted' : delivered ? 'fallback' : 'failed',
      delivery: delivered ? 'text' : 'failed',
      endedAt: now,
    });
    return { reply: wasAborted || !delivered ? '' : candidates[side]!, exposed: false, aborted: wasAborted };
  }

  async loadVotable(userId: string, identifier?: string): Promise<PersonaAbRecord | null> {
    const now = this.#now();
    const found = await this.#repo.transaction(this.#deps.botId, userId, (data) => {
      this.#repo.expire(data);
      const id = identifier ?? data.active ?? undefined;
      if (!id) return null;
      const record = data.records.find((entry) => entry.id === id);
      if (!record) return null;
      if (record.state !== 'pending' && record.state !== 'voted') return null;
      if (now >= record.expiresAt) return null;
      return record;
    });
    return (found as PersonaAbRecord | null) ?? null;
  }

  /** Records a vote. Re-voting keeps the first choice, exactly like upstream. */
  async vote(userId: string, identifier: string | undefined, choice: AbVote): Promise<PersonaAbRecord> {
    const now = this.#now();
    const updated = await this.#repo.transaction(this.#deps.botId, userId, (data) => {
      this.#repo.expire(data);
      const id = identifier ?? data.active ?? undefined;
      const record = id ? data.records.find((entry) => entry.id === id) : undefined;
      if (!record || (record.state !== 'pending' && record.state !== 'voted') || now >= record.expiresAt) {
        throw new Error('评估不存在、未完整展示或已过期（仅限本人当前 Bot 的私聊记录）');
      }
      if (record.vote === null) {
        record.vote = choice;
        record.votedAt = now;
        if (record.state === 'pending') record.state = 'voted';
        if (data.active === record.id) data.active = null;
      }
      return record;
    });
    return updated as PersonaAbRecord;
  }

  /** Binds the user's preferred persona. The chat history is untouched. */
  async switchPersona(userId: string, identifier: string, choice: 'A' | 'B'): Promise<PersonaAbRecord> {
    const now = this.#now();
    const updated = await this.#repo.transaction(this.#deps.botId, userId, (data) => {
      this.#repo.expire(data);
      const record = data.records.find((entry) => entry.id === identifier);
      if (!record || (record.state !== 'pending' && record.state !== 'voted') || now >= record.expiresAt) {
        throw new Error('评估不存在、未投票或已过期');
      }
      const side = record.mapping[choice];
      if (!side) throw new Error('切换只接受 A 或 B');
      record.switch = { choice, at: now, side };
      return record;
    });
    return updated as PersonaAbRecord;
  }

  /** Which side this user last switched to, if any. */
  async preference(userId: string): Promise<AbSide | null> {
    const now = this.#now();
    const found = await this.#repo.transaction(this.#deps.botId, userId, (data) => {
      this.#repo.expire(data);
      const switched = data.records.filter((record) => record.switch !== null);
      return switched.length > 0 ? switched[switched.length - 1]!.switch!.side : null;
    });
    return (found as AbSide | null) ?? null;
  }

  async stats(): Promise<PersonaAbStats> {
    const records = await this.#repo.allRecords(this.#deps.botId);
    const stats: PersonaAbStats = {
      shown: 0, votes: 0, baselineWins: 0, testWins: 0, ties: 0, bothBad: 0, skipped: 0, expired: 0, failed: 0,
      responseRate: 0, notice: '单轮同历史偏好，不代表长期实验。',
    };
    for (const record of records) {
      if (record.exposedAt !== null) stats.shown += 1;
      const vote = record.vote;
      if (vote) {
        stats.votes += vote === '跳过' ? 0 : 1;
        if (vote === 'A') stats[`${record.mapping.A}Wins` as 'baselineWins' | 'testWins'] += 1;
        else if (vote === 'B') stats[`${record.mapping.B}Wins` as 'baselineWins' | 'testWins'] += 1;
        else if (vote === '平局') stats.ties += 1;
        else if (vote === '都不好') stats.bothBad += 1;
        else stats.skipped += 1;
      }
      if (record.state === 'expired') stats.expired += 1;
      if (record.state === 'failed' || record.state === 'aborted' || record.state === 'fallback') stats.failed += 1;
    }
    stats.responseRate = stats.shown > 0 ? Math.round((stats.votes / stats.shown) * 1000) / 1000 : 0;
    return { ...stats, notice: '单轮同历史偏好，不代表长期实验。' };
  }
}
