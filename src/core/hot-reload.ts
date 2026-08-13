/**
 * Hot reload watcher.
 *
 * Watches config/, plugins/ and characters/ and hands debounced, classified
 * change events to the runtime. The watcher itself NEVER applies a change and
 * never throws upward - a failed reload leaves the previous version running.
 */

import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { HotReloadConfig } from '../config/schema.js';
import type { Logger } from './logger.js';
import type { Managed } from './types.js';

export type ReloadKind = 'config' | 'plugin' | 'character' | 'unknown';

export interface ReloadEvent {
  kind: ReloadKind;
  /** Absolute path that changed. */
  path: string;
  /** For kind === 'plugin': the plugin directory name. */
  target?: string;
  action: 'add' | 'change' | 'unlink';
}

export type ReloadHandler = (event: ReloadEvent) => Promise<void> | void;

export class HotReloader implements Managed {
  readonly name = 'hot-reload';
  readonly #config: HotReloadConfig;
  readonly #rootDir: string;
  readonly #logger: Logger;
  readonly #handler: ReloadHandler;
  #watcher?: FSWatcher;
  #pending = new Map<string, ReloadEvent>();
  #timer?: NodeJS.Timeout;
  #running = false;

  constructor(opts: { config: HotReloadConfig; rootDir: string; logger: Logger; onReload: ReloadHandler }) {
    this.#config = opts.config;
    this.#rootDir = opts.rootDir;
    this.#logger = opts.logger.child({ component: 'hot-reload' });
    this.#handler = opts.onReload;
  }

  async start(): Promise<void> {
    if (this.#running) return;
    if (!this.#config.enabled) {
      this.#logger.info('hot reload disabled by config');
      return;
    }
    const paths = this.#config.paths.map((p) => (path.isAbsolute(p) ? p : path.join(this.#rootDir, p)));
    this.#watcher = chokidar.watch(paths, {
      ignoreInitial: true,
      persistent: true,
      // Wait for the writer to finish so we never read a half-written file.
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      ignored: (p: string) =>
        p.includes('node_modules') || p.includes('/.git/') || p.endsWith('~') || p.endsWith('.swp'),
    });

    for (const action of ['add', 'change', 'unlink'] as const) {
      this.#watcher.on(action, (changed: string) => this.#enqueue(action, changed));
    }
    this.#watcher.on('error', (error: unknown) => {
      this.#logger.error({ err: error instanceof Error ? error.message : String(error) }, 'watcher error');
    });

    this.#running = true;
    this.#logger.info({ paths }, 'watching for changes');
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#pending.clear();
    if (this.#watcher) {
      await this.#watcher.close().catch(() => {});
      this.#watcher = undefined;
    }
  }

  /** Exposed for tests: classify a path without touching the filesystem. */
  classify(changed: string): ReloadEvent['kind'] {
    const rel = path.relative(this.#rootDir, changed).replaceAll('\\', '/');
    if (rel.startsWith('config/')) return 'config';
    if (rel.startsWith('data/')) return 'config';
    if (rel.startsWith('plugins/')) return 'plugin';
    if (rel.startsWith('characters/')) return 'character';
    return 'unknown';
  }

  #enqueue(action: ReloadEvent['action'], changed: string): void {
    const kind = this.classify(changed);
    if (kind === 'unknown') return;
    // Only source-ish files matter.
    const ext = path.extname(changed);
    if (!['.ts', '.js', '.mjs', '.json', '.yaml', '.yml', '.md', '.txt'].includes(ext)) return;

    const event: ReloadEvent = { kind, path: changed, action };
    if (kind === 'plugin') {
      const rel = path.relative(path.join(this.#rootDir, 'plugins'), changed).replaceAll('\\', '/');
      const dir = rel.split('/')[0];
      if (dir) event.target = dir;
    }
    // Collapse repeated events for the same logical target.
    const dedupeKey = `${kind}:${event.target ?? event.path}`;
    this.#pending.set(dedupeKey, event);

    if (this.#timer) clearTimeout(this.#timer);
    const timer = setTimeout(() => void this.#flush(), this.#config.debounceMs);
    timer.unref?.();
    this.#timer = timer;
  }

  async #flush(): Promise<void> {
    const events = [...this.#pending.values()];
    this.#pending.clear();
    this.#timer = undefined;
    for (const event of events) {
      this.#logger.info({ kind: event.kind, target: event.target, action: event.action }, 'change detected');
      try {
        await this.#handler(event);
      } catch (error) {
        // A failed reload must leave the runtime exactly as it was.
        this.#logger.error(
          { kind: event.kind, target: event.target, err: error instanceof Error ? error.message : String(error) },
          'reload handler failed; keeping previous version',
        );
      }
    }
  }
}
