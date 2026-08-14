import type { Logger } from '../core/logger.js';
import type { RemoteServices } from './remote-factory.js';
import { Outbox, type AppendOutboxEvent, type OutboxEvent } from './outbox.js';
import { OutboxWorker, type OutboxWorkerOptions, type OutboxWorkerStats, type RemoteMirror } from './outbox-worker.js';
import type { RemoteStorageConfig } from './remote-config.js';

export class RemoteAuthoritativeUnsupportedError extends Error {
  constructor(detail = 'remote-authoritative requires an available remote mirror') {
    super(detail);
    this.name = 'RemoteAuthoritativeUnsupportedError';
  }
}

/** Sends one event to every configured destination; completion requires all destinations. */
export class CompositeRemoteMirror implements RemoteMirror {
  readonly #mirrors: readonly RemoteMirror[];
  constructor(mirrors: readonly RemoteMirror[]) {
    this.#mirrors = [...mirrors];
  }
  get size(): number { return this.#mirrors.length; }
  async send(event: OutboxEvent): Promise<void> {
    const results = await Promise.allSettled(this.#mirrors.map((mirror) => mirror.send(event)));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length > 0) {
      const detail = failures.map((failure) => failure.reason instanceof Error ? failure.reason.message : String(failure.reason)).join('; ');
      throw new Error(`remote mirror partially failed (${failures.length}/${results.length}): ${detail}`);
    }
  }
}

export interface RuntimeRemoteHealth {
  mode: RemoteStorageConfig['mode'];
  local: { available: true };
  worker: { running: boolean; stats: OutboxWorkerStats };
  remote: Awaited<ReturnType<RemoteServices['health']>>;
}

export interface RuntimeRemoteCoordinatorOptions {
  config: RemoteStorageConfig;
  outbox: Outbox;
  services: RemoteServices;
  logger: Logger;
  worker?: OutboxWorker;
  workerOptions?: OutboxWorkerOptions;
}

/** Owns the production lifecycle between local Outbox and optional remotes. */
export class RuntimeRemoteCoordinator {
  readonly #config: RemoteStorageConfig;
  readonly #outbox: Outbox;
  readonly #services: RemoteServices;
  readonly #logger: Logger;
  readonly #worker: OutboxWorker;
  #started = false;
  #stopped = false;

  constructor(options: RuntimeRemoteCoordinatorOptions) {
    this.#config = options.config;
    this.#outbox = options.outbox;
    this.#services = options.services;
    this.#logger = options.logger.child({ component: 'remote-coordinator' });
    if (this.#config.mode === 'remote-authoritative') {
      throw new RemoteAuthoritativeUnsupportedError('remote-authoritative is unsupported by the local-first Outbox runtime');
    }
    const mirror = new CompositeRemoteMirror(this.#services.mirrors);
    this.#worker = options.worker ?? new OutboxWorker(this.#outbox, mirror, this.#logger, {
      ...this.#config.worker,
      ...options.workerOptions,
    });
  }

  get worker(): OutboxWorker { return this.#worker; }
  get started(): boolean { return this.#started; }

  /** Stable local-first event API. It is safe to call before start(). */
  async append<T>(event: AppendOutboxEvent<T>): Promise<OutboxEvent<T>> {
    if (this.#stopped) throw new Error('remote coordinator is stopped');
    return this.#outbox.append(event);
  }

  start(): void {
    if (this.#stopped) throw new Error('remote coordinator is stopped');
    if (this.#started || this.#config.mode !== 'async-mirror' || this.#services.mirrors.length === 0) return;
    this.#started = true;
    this.#worker.start();
  }

  async drain(): Promise<number> {
    if (this.#stopped) return 0;
    if (this.#config.mode !== 'async-mirror' || this.#services.mirrors.length === 0) return 0;
    return this.#worker.flush();
  }

  async health(): Promise<RuntimeRemoteHealth> {
    return {
      mode: this.#config.mode,
      local: { available: true },
      worker: { running: this.#worker.running, stats: this.#worker.stats() },
      remote: await this.#services.health(),
    };
  }

  /** Stop claims, wait for in-flight sends, then close remote resources. */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    await this.#worker.stop();
    await this.#services.close();
    this.#started = false;
  }
}
