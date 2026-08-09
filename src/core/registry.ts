/**
 * Typed extension registry.
 *
 * This is the mechanism that keeps MohoBot open for extension and closed for
 * modification: new AI providers, gateways, storage drivers and memory
 * adapters are REGISTERED, never added to an if/else inside the runtime.
 *
 * A plugin can call `registry.register(...)` from its `onLoad` and the runtime
 * will use it on the next bot start, with zero changes to src/.
 */

import type { Logger } from './logger.js';
import type { AIConfig } from '../config/schema.js';

export interface RegistryEntry<T> {
  /** Unique key used in config, e.g. `discord`, `sqlite`, `openai`. */
  name: string;
  /** Who registered it - used in diagnostics. */
  source: string;
  factory: T;
  description?: string;
  /**
   * Optional capability hook. For the provider registry this is
   * `needsKey(cfg)`: does this backend require a credential before it can be
   * used? A plugin declares its OWN key source here (e.g. KILO_API_KEY,
   * NVIDIA_NIM_API_KEY) so the runtime does not force every provider to read
   * `AI_API_KEY`. Undefined means "use the default rule" (cfg.apiKey empty).
   */
  needsKey?: (cfg: AIConfig) => boolean;
}

export interface RegisterOptions {
  /** Who is registering (built-in module name or plugin id). */
  source?: string;
  description?: string;
  /**
   * Declare a custom credential rule for this entry (see RegistryEntry.needsKey).
   * Lets a plugin provider read its key from a vendor-specific env var instead
   * of the shared `AI_API_KEY`.
   */
  needsKey?: (cfg: AIConfig) => boolean;
  /** Allow replacing an existing entry. Default false. */
  override?: boolean;
}

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryError';
  }
}

/**
 * A small name -> factory map with collision protection and helpful errors.
 *
 * Deliberately NOT a singleton class hierarchy: each registry instance is a
 * plain object created in `src/core/registries.ts`, so tests can build
 * throwaway registries without touching global state.
 */
export class Registry<T> {
  readonly #entries = new Map<string, RegistryEntry<T>>();

  constructor(
    /** Human label used in error messages, e.g. "AI provider". */
    readonly label: string,
  ) {}

  register(name: string, factory: T, options: RegisterOptions = {}): this {
    const key = name.trim().toLowerCase();
    if (key.length === 0) throw new RegistryError(`${this.label}: name must not be empty`);

    const existing = this.#entries.get(key);
    if (existing && !options.override) {
      throw new RegistryError(
        `${this.label} "${key}" is already registered by "${existing.source}". ` +
          'Pass { override: true } if replacing it is intentional.',
      );
    }

    this.#entries.set(key, {
      name: key,
      source: options.source ?? 'unknown',
      factory,
      description: options.description,
      needsKey: options.needsKey,
    });
    return this;
  }

  /** Remove an entry. Used when a plugin that registered it unloads. */
  unregister(name: string): boolean {
    return this.#entries.delete(name.trim().toLowerCase());
  }

  /** Remove every entry registered by a given source (plugin teardown). */
  unregisterSource(source: string): string[] {
    const removed: string[] = [];
    for (const [key, entry] of [...this.#entries]) {
      if (entry.source === source) {
        this.#entries.delete(key);
        removed.push(key);
      }
    }
    return removed;
  }

  has(name: string): boolean {
    return this.#entries.has(name.trim().toLowerCase());
  }

  /**
   * Does the named entry need a credential before use?
   *
   * Delegates to the entry's own `needsKey` hook when present (so a plugin
   * provider can read a vendor-specific env var); otherwise falls back to the
   * default rule: a provider is usable when `cfg.apiKey` is non-empty.
   * Throws RegistryError if the name is unknown.
   */
  needsKey(name: string, cfg: AIConfig): boolean {
    const entry = this.#entries.get(name.trim().toLowerCase());
    if (!entry) throw new RegistryError(`unknown ${this.label} "${name}"`);
    if (typeof entry.needsKey === 'function') return entry.needsKey(cfg);
    return cfg.apiKey.trim() === '';
  }

  get(name: string): T | undefined {
    return this.#entries.get(name.trim().toLowerCase())?.factory;
  }

  /** Get or throw with a message that lists what IS available. */
  require(name: string): T {
    const found = this.get(name);
    if (found) return found;
    throw new RegistryError(
      `unknown ${this.label} "${name}". Registered: ${this.names().join(', ') || '(none)'}`,
    );
  }

  /**
   * Resolve with graceful degradation: falls back to `fallback` and warns
   * instead of throwing, so a typo in config cannot stop the runtime booting.
   */
  resolve(name: string, fallback: string, logger?: Logger): T {
    const found = this.get(name);
    if (found) return found;
    logger?.warn(
      { requested: name, fallback, available: this.names() },
      `unknown ${this.label}; falling back`,
    );
    return this.require(fallback);
  }

  names(): string[] {
    return [...this.#entries.keys()].sort();
  }

  list(): RegistryEntry<T>[] {
    return [...this.#entries.values()].map((e) => ({ ...e }));
  }

  get size(): number {
    return this.#entries.size;
  }
}
