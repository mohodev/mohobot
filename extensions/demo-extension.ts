/**
 * PROOF-OF-EXTENSIBILITY example.
 *
 * This single file adds a new AI provider, a new chat gateway, a new storage
 * driver AND a long-term memory adapter - without touching one line of src/.
 *
 * Enable by pointing config at the registered names:
 *   bots/main.yaml:  adapter: webhook
 *                    ai: { provider: echo-upper }
 *                    memory: { adapter: keyword }
 *   global.yaml:     storage: { driver: jsonl }
 *
 * Delete this file and the runtime behaves exactly as before.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Registries } from '../src/core/registries.js';
import type { Logger } from '../src/core/logger.js';
import type { AIProvider, AIResponse } from '../src/ai/types.js';
import type { Gateway, GatewayStatus } from '../src/discord/types.js';
import type { ChatMessage, MohoMessage, OutboundMessage } from '../src/core/types.js';
import type { MemoryAdapter, QueryFilter, Storage, StoredRecord } from '../src/storage/types.js';

/* ------------------------------------------------------------------ *
 * 1. A brand-new AI provider                                          *
 * ------------------------------------------------------------------ */
class EchoUpperProvider implements AIProvider {
  readonly name = 'echo-upper';
  constructor(readonly model: string) {}

  async chat(messages: ChatMessage[]): Promise<AIResponse> {
    const last = [...messages].reverse().find((m) => m.role === 'user');
    return { content: (last?.content ?? '').toUpperCase(), model: this.model, ms: 0 };
  }

  async health(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
}

/* ------------------------------------------------------------------ *
 * 2. A brand-new gateway (a fake "webhook" platform)                  *
 * ------------------------------------------------------------------ */
class WebhookGateway implements Gateway {
  readonly platform = 'webhook';
  readonly name: string;
  #connected = false;
  #onMessage?: (m: MohoMessage) => void | Promise<void>;
  readonly sent: OutboundMessage[] = [];

  constructor(private readonly botId: string, private readonly logger: Logger) {
    this.name = `gateway:webhook:${botId}`;
  }

  async start(): Promise<void> {
    this.#connected = true;
    this.logger.info({ bot: this.botId }, 'webhook gateway started (extension)');
  }

  async stop(): Promise<void> {
    this.#connected = false;
  }

  onMessage(handler: (m: MohoMessage) => void | Promise<void>): void {
    this.#onMessage = handler;
  }

  async send(out: OutboundMessage): Promise<void> {
    this.sent.push(out);
    process.stdout.write(`[webhook] ${out.content}\n`);
  }

  status(): GatewayStatus {
    return { connected: this.#connected, ping: 0, platform: this.platform, botId: this.botId };
  }

  /** Test hook: pretend an inbound HTTP call arrived. */
  async inject(content: string): Promise<void> {
    await this.#onMessage?.({
      id: `wh-${Date.now()}`,
      platform: 'webhook',
      botId: this.botId,
      channel: { id: 'hook', dm: true },
      author: { id: 'caller', username: 'caller', bot: false },
      content,
      mentionsBot: true,
      attachments: [],
      createdAt: Date.now(),
    });
  }
}

/* ------------------------------------------------------------------ *
 * 3. A brand-new storage driver (append-only JSONL)                   *
 * ------------------------------------------------------------------ */
class JsonlStorage implements Storage {
  readonly #rows = new Map<string, StoredRecord>();
  #ready = false;

  constructor(private readonly file: string, private readonly logger: Logger) {}

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const text = await fs.readFile(this.file, 'utf8');
      for (const line of text.split('\n').filter(Boolean)) {
        const row = JSON.parse(line) as StoredRecord;
        this.#rows.set(row.key, row);
      }
    } catch {
      /* first run */
    }
    this.#ready = true;
    this.logger.info({ file: this.file, rows: this.#rows.size }, 'jsonl storage ready (extension)');
  }

  async save(key: string, value: unknown): Promise<void> {
    const row: StoredRecord = { key, value, updatedAt: Date.now() };
    this.#rows.set(key, row);
    await fs.appendFile(this.file, `${JSON.stringify(row)}\n`, 'utf8');
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.#rows.get(key)?.value as T | undefined;
  }

  async delete(key: string): Promise<boolean> {
    return this.#rows.delete(key);
  }

  async query(filter: QueryFilter = {}): Promise<StoredRecord[]> {
    let rows = [...this.#rows.values()];
    if (filter.prefix) rows = rows.filter((r) => r.key.startsWith(filter.prefix!));
    if (filter.limit !== undefined) rows = rows.slice(filter.offset ?? 0, (filter.offset ?? 0) + filter.limit);
    return rows;
  }

  async close(): Promise<void> {
    this.#ready = false;
  }

  get ready(): boolean {
    return this.#ready;
  }
}

/* ------------------------------------------------------------------ *
 * 4. A long-term memory adapter                                       *
 * ------------------------------------------------------------------ */
class KeywordMemory implements MemoryAdapter {
  readonly name = 'keyword';
  constructor(private readonly storage: Storage | undefined, private readonly logger: Logger) {}

  #key(botId: string, userId: string): string {
    return `longterm:${botId}:${userId}`;
  }

  async recall(input: { botId: string; channelId: string; userId: string; query: string }): Promise<ChatMessage[]> {
    const facts = (await this.storage?.get<string[]>(this.#key(input.botId, input.userId))) ?? [];
    if (facts.length === 0) return [];
    return [{ role: 'system', content: `Known facts about this user: ${facts.join('; ')}` }];
  }

  async remember(input: { botId: string; userId: string; user: ChatMessage }): Promise<void> {
    const match = /my name is (\w+)/i.exec(input.user.content);
    if (!match) return;
    const key = this.#key(input.botId, input.userId);
    const facts = (await this.storage?.get<string[]>(key)) ?? [];
    const fact = `name=${match[1]}`;
    if (!facts.includes(fact)) {
      await this.storage?.save(key, [...facts, fact]);
      this.logger.info({ fact }, 'long-term memory stored (extension)');
    }
  }
}

/* ------------------------------------------------------------------ *
 * Registration - the only contract this file needs to satisfy.        *
 * ------------------------------------------------------------------ */
export function register(registries: Registries, logger: Logger): void {
  registries.providers.register(
    'echo-upper',
    (cfg) => new EchoUpperProvider(cfg.model),
    { source: 'extension:demo', description: 'Shouts the user message back' },
  );

  registries.gateways.register(
    'webhook',
    (cfg, deps) => new WebhookGateway(cfg.id, deps.logger),
    { source: 'extension:demo', description: 'Fake webhook platform' },
  );

  registries.storages.register(
    'jsonl',
    (cfg, deps) => new JsonlStorage(path.resolve(deps.rootDir, cfg.path.replace(/\.db$/, '.jsonl')), deps.logger),
    { source: 'extension:demo', description: 'Append-only JSONL store' },
  );

  registries.memories.register(
    'keyword',
    (deps) => new KeywordMemory(deps.storage, deps.logger),
    { source: 'extension:demo', description: 'Remembers "my name is X"' },
  );

  logger.info('demo extension registered 4 capabilities without touching src/');
}

export { EchoUpperProvider, WebhookGateway, JsonlStorage, KeywordMemory };
