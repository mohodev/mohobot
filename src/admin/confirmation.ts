import crypto from 'node:crypto';
import type { AdminPermission, AdminPrincipal } from './rbac.js';
import { can } from './rbac.js';

export interface ConfirmationRequest {
  principal: AdminPrincipal;
  permission: AdminPermission;
  action: string;
  payload?: unknown;
}

export interface ConfirmationChallenge {
  nonce: string;
  expiresAt: number;
  actionDigest: string;
}

interface StoredConfirmation {
  nonceHash: string;
  principalId: string;
  permission: AdminPermission;
  actionDigest: string;
  expiresAt: number;
  state: 'pending' | 'consumed';
}

export interface ConfirmationStoreOptions {
  ttlMs?: number;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
  pepper?: Buffer;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

function canonical(value: unknown, seen = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('confirmation payload contains a non-finite number');
    return Object.is(value, -0) ? '0' : String(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, seen)).join(',')}]`;
  if (typeof value === 'object') {
    if (seen.has(value)) throw new Error('confirmation payload contains a cycle');
    seen.add(value);
    const record = value as Record<string, unknown>;
    const output = `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key], seen)}`).join(',')}}`;
    seen.delete(value);
    return output;
  }
  if (value === undefined) return 'undefined';
  throw new Error('confirmation payload contains an unsupported value');
}

export function actionDigest(request: Pick<ConfirmationRequest, 'principal' | 'permission' | 'action' | 'payload'>): string {
  const action = request.action.trim();
  if (!action || action.length > 256) throw new Error('confirmation action is invalid');
  const bound = canonical({
    principalId: request.principal.id,
    permission: request.permission,
    action,
    payload: request.payload,
  });
  return crypto.createHash('sha256').update(bound, 'utf8').digest('hex');
}

/** One-time, permission-bound confirmation challenges for sensitive actions. */
export class ConfirmationStore {
  readonly #entries = new Map<string, StoredConfirmation>();
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #randomBytes: (size: number) => Buffer;
  readonly #pepper: Buffer;

  constructor(options: ConfirmationStoreOptions = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs <= 0) throw new Error('confirmation ttl must be a positive safe integer');
    this.#now = options.now ?? Date.now;
    this.#randomBytes = options.randomBytes ?? crypto.randomBytes;
    this.#pepper = options.pepper ? Buffer.from(options.pepper) : this.#randomBytes(32);
    if (this.#pepper.length < 16) throw new Error('confirmation pepper must contain at least 16 bytes');
  }

  issue(request: ConfirmationRequest, ttlMs = this.#ttlMs): ConfirmationChallenge {
    if (!can(request.principal, request.permission)) throw new Error('forbidden');
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error('confirmation ttl must be a positive safe integer');
    const nonce = `mohoc_${this.#randomBytes(32).toString('base64url')}`;
    const nonceHash = this.#hash(nonce);
    const digest = actionDigest(request);
    const entry: StoredConfirmation = {
      nonceHash,
      principalId: request.principal.id,
      permission: request.permission,
      actionDigest: digest,
      expiresAt: this.#now() + ttlMs,
      state: 'pending',
    };
    this.#entries.set(nonceHash, entry);
    return { nonce, expiresAt: entry.expiresAt, actionDigest: digest };
  }

  /**
   * Atomically consumes the challenge before returning success. JavaScript's
   * run-to-completion semantics make two synchronous consumers unable to pass
   * the pending check, preventing replay within one process.
   */
  consume(nonce: string, request: ConfirmationRequest): boolean {
    if (!nonce || nonce.length > 512) return false;
    const nonceHash = this.#hash(nonce);
    const entry = this.#entries.get(nonceHash);
    if (!entry || entry.state !== 'pending') return false;
    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(nonceHash);
      return false;
    }
    if (!can(request.principal, request.permission)) return false;
    const digest = actionDigest(request);
    if (
      entry.principalId !== request.principal.id ||
      entry.permission !== request.permission ||
      !crypto.timingSafeEqual(Buffer.from(entry.actionDigest, 'hex'), Buffer.from(digest, 'hex'))
    ) return false;

    entry.state = 'consumed';
    this.#entries.delete(nonceHash);
    return true;
  }

  revoke(nonce: string): boolean {
    if (!nonce || nonce.length > 512) return false;
    return this.#entries.delete(this.#hash(nonce));
  }

  sweep(): number {
    const now = this.#now();
    let removed = 0;
    for (const [hash, entry] of this.#entries) {
      if (entry.expiresAt <= now || entry.state !== 'pending') {
        this.#entries.delete(hash);
        removed += 1;
      }
    }
    return removed;
  }

  pending(): number {
    this.sweep();
    return this.#entries.size;
  }

  #hash(nonce: string): string {
    return crypto.createHmac('sha256', this.#pepper).update(nonce, 'utf8').digest('hex');
  }
}
