/**
 * Context Archiver - JSONL session context archive with compression & TTL.
 * 
 * Stores conversation history as JSONL files per bot/channel:
 *   data/contexts/<bot_id>/<channel_id>.jsonl
 * 
 * Features:
 * - Line-by-line JSONL format (append-only, efficient)
 * - Optional gzip compression for archived files
 * - TTL-based expiry with periodic sweep
 * - 40-entry rotation threshold: older entries are gzip-archived (NOT LLM-summarized)
 *
 * NOTE: this is an audit archive only. It never feeds the model. The live,
 * LLM-summarized context lives in SessionManager (src/session/manager.ts).
 */

import fs from 'node:fs';
import path from 'node:path';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

import type { Logger } from '../core/logger.js';

const gzipAsync = promisify(gzip);

export interface ContextEntry {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number; // epoch ms
  tokenCount?: number;
  senderId?: string;
  senderName?: string;
}

export interface ContextArchiverOptions {
  rootDir: string;
  logger: Logger;
  maxTurnsPerFile?: number;      // default: 40 turns before compression
  archiveAgeHours?: number;      // default: 24 hours before archiving
  compressArchived?: boolean;    // default: true
}

export class ContextArchiver {
  readonly #rootDir: string;
  readonly #logger: Logger;
  readonly #maxTurnsPerFile: number;
  readonly #archiveAgeHours: number;
  readonly #compressArchived: boolean;

  constructor(opts: ContextArchiverOptions) {
    this.#rootDir = opts.rootDir;
    this.#logger = opts.logger;
    this.#maxTurnsPerFile = opts.maxTurnsPerFile ?? 40;
    this.#archiveAgeHours = opts.archiveAgeHours ?? 24;
    this.#compressArchived = opts.compressArchived ?? true;
  }

  /**
   * Get the context directory for a specific bot.
   */
  #getContextDir(botId: string): string {
    return path.join(this.#rootDir, 'data', 'contexts', botId);
  }

  /**
   * Get the JSONL file path for a specific channel.
   */
  #getFilePath(botId: string, channelId: string): string {
    const contextDir = this.#getContextDir(botId);
    return path.join(contextDir, `${channelId}.jsonl`);
  }

  /**
   * Append a message to the context archive.
   */
  async append(botId: string, channelId: string, entry: ContextEntry): Promise<void> {
    const filePath = this.#getFilePath(botId, channelId);
    const contextDir = path.dirname(filePath);

    // Ensure directory exists
    fs.mkdirSync(contextDir, { recursive: true });

    const line = JSON.stringify(entry) + '\n';

    // Append to file (sync for simplicity, JSONL is append-only)
    fs.appendFileSync(filePath, line, 'utf8');

    this.#logger.debug(
      { botId, channelId, role: entry.role, filePath },
      'appended context entry',
    );
  }

  /**
   * Read all context entries from a channel.
   */
  async read(botId: string, channelId: string): Promise<ContextEntry[]> {
    const filePath = this.#getFilePath(botId, channelId);
    if (!fs.existsSync(filePath)) {
      return [];
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.trim().split('\n').filter((l) => l.length > 0);

    const entries: ContextEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        // Skip malformed lines
      }
    }

    return entries;
  }

  /**
   * Count entries in a channel's context.
   */
  async count(botId: string, channelId: string): Promise<number> {
    const entries = await this.read(botId, channelId);
    return entries.length;
  }

  /**
   * Check if a channel's context needs compression (exceeds max turns).
   */
  async needsCompression(botId: string, channelId: string): Promise<boolean> {
    const count = await this.count(botId, channelId);
    return count >= this.#maxTurnsPerFile;
  }

  /**
   * Compress old context by creating a summary and archiving.
   * Returns the new token count after compression.
   */
  async compress(botId: string, channelId: string): Promise<number> {
    const entries = await this.read(botId, channelId);
    if (entries.length < this.#maxTurnsPerFile) {
      return entries.length;
    }

    // Keep recent entries (last N), compress the rest
    const recent = entries.slice(-this.#maxTurnsPerFile);
    const old = entries.slice(0, -this.#maxTurnsPerFile);

    // Calculate token count (simplified: 1 token ≈ 4 chars)
    const oldTokenCount = old.reduce((sum, e) => sum + Math.ceil(e.content.length / 4), 0);

    // Write compressed summary
    const summaryPath = path.join(
      this.#rootDir,
      'data',
      'contexts',
      'archived',
      `${botId}-${channelId}-${Date.now()}.jsonl.gz`,
    );
    fs.mkdirSync(path.dirname(summaryPath), { recursive: true });

    // Archive old entries if compression is enabled
    if (this.#compressArchived) {
      const archiveContent = old.map((e) => JSON.stringify(e)).join('\n') + '\n';
      const compressed = await gzipAsync(Buffer.from(archiveContent, 'utf8'));
      fs.writeFileSync(summaryPath, compressed);
    }

    // Rewrite current file with recent entries only
    const filePath = this.#getFilePath(botId, channelId);
    const newContent = recent.map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(filePath, newContent, 'utf8');

    this.#logger.info(
      { botId, channelId, oldCount: old.length, newCount: recent.length, oldTokenCount },
      'context compressed',
    );

    return recent.reduce((sum, e) => sum + (e.tokenCount ?? Math.ceil(e.content.length / 4)), 0);
  }

  /**
   * Sweep all channels and archive/compress based on TTL.
   * Returns the number of channels processed.
   */
  async sweep(): Promise<number> {
    const contextsDir = path.join(this.#rootDir, 'data', 'contexts');
    if (!fs.existsSync(contextsDir)) {
      return 0;
    }

    const botDirs = fs.readdirSync(contextsDir).filter((d) => {
      const stat = fs.statSync(path.join(contextsDir, d));
      return stat.isDirectory() && d !== 'archived';
    });

    let processed = 0;
    for (const botId of botDirs) {
      const botDir = path.join(contextsDir, botId);
      const files = fs.readdirSync(botDir).filter((f) => f.endsWith('.jsonl'));

      for (const file of files) {
        const channelId = file.replace('.jsonl', '');
        const filePath = path.join(botDir, file);
        const stats = fs.statSync(filePath);
        const ageHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);

        // Archive if old enough
        if (ageHours >= this.#archiveAgeHours) {
          const archivePath = path.join(
            this.#rootDir,
            'data',
            'contexts',
            'archived',
            `${botId}-${channelId}-${stats.mtimeMs}.jsonl.gz`,
          );
          fs.mkdirSync(path.dirname(archivePath), { recursive: true });

          if (this.#compressArchived) {
            const content = fs.readFileSync(filePath, 'utf8');
            const compressed = await gzipAsync(Buffer.from(content, 'utf8'));
            fs.writeFileSync(archivePath, compressed);
          }

          fs.unlinkSync(filePath);
          this.#logger.info(
            { botId, channelId, ageHours },
            'context archived (TTL expired)',
          );
        } else if (await this.needsCompression(botId, channelId)) {
          await this.compress(botId, channelId);
        }

        processed++;
      }
    }

    return processed;
  }

  /**
   * Get statistics for all channels.
   */
  async stats(): Promise<Record<string, { channels: number; totalEntries: number }>> {
    const contextsDir = path.join(this.#rootDir, 'data', 'contexts');
    if (!fs.existsSync(contextsDir)) {
      return {};
    }

    const result: Record<string, { channels: number; totalEntries: number }> = {};
    const botDirs = fs.readdirSync(contextsDir).filter((d) => {
      const stat = fs.statSync(path.join(contextsDir, d));
      return stat.isDirectory() && d !== 'archived';
    });

    for (const botId of botDirs) {
      const botDir = path.join(contextsDir, botId);
      const files = fs.readdirSync(botDir).filter((f) => f.endsWith('.jsonl'));

      let totalEntries = 0;
      for (const file of files) {
        const entries = await this.read(botId, file.replace('.jsonl', ''));
        totalEntries += entries.length;
      }

      result[botId] = {
        channels: files.length,
        totalEntries,
      };
    }

    return result;
  }

  /**
   * Delete all archived files older than specified hours.
   */
  async clearArchived(olderThanHours: number = 30 * 24): Promise<number> {
    const archivedDir = path.join(this.#rootDir, 'data', 'contexts', 'archived');
    if (!fs.existsSync(archivedDir)) {
      return 0;
    }

    const files = fs.readdirSync(archivedDir).filter((f) => f.endsWith('.gz'));
    let deleted = 0;

    for (const file of files) {
      const filePath = path.join(archivedDir, file);
      const stats = fs.statSync(filePath);
      const ageHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);

      if (ageHours >= olderThanHours) {
        fs.unlinkSync(filePath);
        deleted++;
      }
    }

    if (deleted > 0) {
      this.#logger.info({ deleted }, 'archived contexts cleared');
    }

    return deleted;
  }
}
