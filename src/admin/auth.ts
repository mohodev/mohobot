import crypto from 'node:crypto';
import type { AdminPrincipal } from './rbac.js';

export interface AdminSession {
  id: string;
  principal: AdminPrincipal;
  createdAt: number;
  expiresAt: number;
}

interface StoredSession extends AdminSession {
  tokenHash: string;
}

export interface AdminSessionStoreOptions {
  ttlMs?: number;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
  /** Process-local pepper. A random value is generated when omitted. */
  pepper?: Buffer;
}

const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;

function clonePrincipal(principal: AdminPrincipal): AdminPrincipal {
  return { ...principal };
}

/**
 * Process-local administrator sessions.
 *
 * The bearer token is returned exactly once by `create()`. Only its keyed hash
 * is retained, so snapshots, heap inspection of records, and logs do not expose
 * reusable session credentials.
 */
export class AdminSessionStore {
  readonly #sessions = new Map<string, StoredSession>();
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #randomBytes: (size: number) => Buffer;
  readonly #pepper: Buffer;

  constructor(options: AdminSessionStoreOptions = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs <= 0) throw new Error('session ttl must be a positive safe integer');
    this.#now = options.now ?? Date.now;
    this.#randomBytes = options.randomBytes ?? crypto.randomBytes;
    this.#pepper = options.pepper ? Buffer.from(options.pepper) : this.#randomBytes(32);
    if (this.#pepper.length < 16) throw new Error('session pepper must contain at least 16 bytes');
  }

  create(principal: AdminPrincipal, ttlMs = this.#ttlMs): { token: string; session: AdminSession } {
    if (!principal.enabled) throw new Error('disabled principal cannot create a session');
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error('session ttl must be a positive safe integer');
    const now = this.#now();
    const token = `mohos_${this.#randomBytes(32).toString('base64url')}`;
    const tokenHash = this.#hash(token);
    const stored: StoredSession = {
      id: this.#randomBytes(16).toString('hex'),
      principal: clonePrincipal(principal),
      createdAt: now,
      expiresAt: now + ttlMs,
      tokenHash,
    };
    this.#sessions.set(tokenHash, stored);
    return { token, session: this.#public(stored) };
  }

  authenticate(token: string): AdminSession | undefined {
    if (!token || token.length > 512) return undefined;
    const tokenHash = this.#hash(token);
    const stored = this.#sessions.get(tokenHash);
    if (!stored) return undefined;
    if (stored.expiresAt <= this.#now() || !stored.principal.enabled) {
      this.#sessions.delete(tokenHash);
      return undefined;
    }
    return this.#public(stored);
  }

  revoke(token: string): boolean {
    if (!token || token.length > 512) return false;
    return this.#sessions.delete(this.#hash(token));
  }

  revokePrincipal(principalId: string): number {
    let removed = 0;
    for (const [hash, session] of this.#sessions) {
      if (session.principal.id === principalId) {
        this.#sessions.delete(hash);
        removed += 1;
      }
    }
    return removed;
  }

  sweep(): number {
    const now = this.#now();
    let removed = 0;
    for (const [hash, session] of this.#sessions) {
      if (session.expiresAt <= now || !session.principal.enabled) {
        this.#sessions.delete(hash);
        removed += 1;
      }
    }
    return removed;
  }

  /** Safe diagnostic records: hashes and bearer tokens are intentionally absent. */
  list(): AdminSession[] {
    this.sweep();
    return [...this.#sessions.values()].map((session) => this.#public(session));
  }

  #hash(token: string): string {
    return crypto.createHmac('sha256', this.#pepper).update(token, 'utf8').digest('hex');
  }

  #public(session: StoredSession): AdminSession {
    return {
      id: session.id,
      principal: clonePrincipal(session.principal),
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    };
  }
}
