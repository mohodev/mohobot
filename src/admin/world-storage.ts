import fs from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '../core/logger.js';
import { createNullLogger } from '../core/logger.js';
import { SqliteStorage } from '../storage/sqlite.js';
import type { Storage } from '../storage/types.js';
import type { WorldState } from './world.js';

export interface WorldStorageOptions {
  rootDir: string;
  botId?: string;
  storage?: Storage;
  logger?: Logger;
}

/** Persistence boundary for world state. Legacy JSON is input-only and is never rewritten. */
export class WorldStorage {
  readonly #storage: Storage;
  readonly #key: string;
  readonly #legacyFile: string;
  readonly #default: () => WorldState;
  #ready?: Promise<void>;

  constructor(options: WorldStorageOptions, defaultValue: () => WorldState) {
    this.#storage = options.storage ?? new SqliteStorage({
      path: path.join(options.rootDir, 'data', 'mohobot.db'),
      logger: options.logger ?? createNullLogger(),
    });
    this.#key = `world:${options.botId ?? 'default'}`;
    this.#legacyFile = options.botId
      ? path.join(options.rootDir, 'data', 'bots', options.botId, 'world', 'state.json')
      : path.join(options.rootDir, 'data', 'world', 'state.json');
    this.#default = defaultValue;
  }

  async get(): Promise<WorldState | undefined> {
    await this.#init();
    const current = await this.#storage.get<WorldState>(this.#key);
    if (current !== undefined) return structuredClone(current);
    const legacy = await readLegacy(this.#legacyFile);
    const value = legacy ?? this.#default();
    await this.#storage.save(this.#key, value);
    return structuredClone(value);
  }

  async save(value: WorldState): Promise<void> {
    await this.#init();
    await this.#storage.save(this.#key, value);
  }

  async close(): Promise<void> { await this.#storage.close(); }

  async #init(): Promise<void> {
    this.#ready ??= this.#storage.init();
    await this.#ready;
  }
}

async function readLegacy(file: string): Promise<WorldState | undefined> {
  let raw: string;
  try { raw = await fs.readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  const parsed = JSON.parse(raw) as unknown;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'data' in parsed) return (parsed as { data: WorldState }).data;
  return parsed as WorldState;
}
