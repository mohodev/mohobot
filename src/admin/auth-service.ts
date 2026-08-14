import crypto from 'node:crypto';
import type { Storage } from '../storage/types.js';
import type { AdminPrincipal, AdminRole } from './rbac.js';

const USER_PREFIX = 'admin-user:';
const SESSION_PREFIX = 'admin-session:';
const PASSWORD_VERSION = 1;
interface ScryptConfig { N: number; r: number; p: number; keyLength: number }
const DEFAULT_SCRYPT: ScryptConfig = { N: 16_384, r: 8, p: 1, keyLength: 32 };
const PRIVILEGED_ROLES = new Set<AdminRole>(['admin', 'developer']);

export interface ScryptPasswordHash {
  algorithm: 'scrypt';
  version: 1;
  N: number;
  r: number;
  p: number;
  keyLength: number;
  salt: string;
  hash: string;
}

export interface AdminUserRecord {
  kind: 'admin-user';
  id: string;
  username: string;
  normalizedUsername: string;
  role: AdminRole;
  enabled: boolean;
  password: ScryptPasswordHash;
  authVersion: number;
  failedLoginCount: number;
  lockedUntil?: number;
  lastLoginAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface AdminSessionRecord {
  kind: 'admin-session';
  id: string;
  tokenHash: string;
  userId: string;
  normalizedUsername: string;
  authVersion: number;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
}

export interface PublicAdminUser {
  id: string;
  username: string;
  normalizedUsername: string;
  role: AdminRole;
  enabled: boolean;
  authVersion: number;
  failedLoginCount: number;
  lockedUntil?: number;
  lastLoginAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface AuthenticatedAdmin {
  principal: AdminPrincipal;
  user: PublicAdminUser;
  session: Omit<AdminSessionRecord, 'tokenHash'>;
}

export interface AdminAuthServiceOptions {
  storage: Storage;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
  sessionTtlMs?: number;
  maxFailedLogins?: number;
  lockoutMs?: number;
  scrypt?: Partial<ScryptConfig>;
}

export class AdminAuthError extends Error {
  constructor(readonly code: 'invalid_credentials'|'locked'|'disabled'|'not_found'|'username_taken'|'last_admin'|'invalid_input') {
    super(code);
  }
}

export function normalizeAdminUsername(username: string): string {
  const normalized = username.normalize('NFKC').trim().toLocaleLowerCase('en-US');
  if (normalized.length < 1 || normalized.length > 64 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new AdminAuthError('invalid_input');
  }
  return normalized;
}

function userKey(normalized: string): string { return `${USER_PREFIX}${encodeURIComponent(normalized)}`; }
function sessionKey(tokenHash: string): string { return `${SESSION_PREFIX}${tokenHash}`; }
function publicUser(user: AdminUserRecord): PublicAdminUser {
  const { password: _password, kind: _kind, ...safe } = user;
  return safe;
}
function publicSession(session: AdminSessionRecord): Omit<AdminSessionRecord, 'tokenHash'> {
  const { tokenHash: _tokenHash, ...safe } = session;
  return safe;
}
function tokenDigest(token: string): string { return crypto.createHash('sha256').update(token, 'utf8').digest('hex'); }

/** Persistent administrator directory and bearer sessions over the generic Storage contract. */
export class AdminAuthService {
  readonly #storage: Storage;
  readonly #now: () => number;
  readonly #randomBytes: (size: number) => Buffer;
  readonly #sessionTtlMs: number;
  readonly #maxFailedLogins: number;
  readonly #lockoutMs: number;
  readonly #scrypt: ScryptConfig;
  #mutation = Promise.resolve();
  #dummyHash?: Promise<ScryptPasswordHash>;

  constructor(options: AdminAuthServiceOptions) {
    this.#storage = options.storage;
    this.#now = options.now ?? Date.now;
    this.#randomBytes = options.randomBytes ?? crypto.randomBytes;
    this.#sessionTtlMs = positiveInt(options.sessionTtlMs, 8 * 60 * 60 * 1000);
    this.#maxFailedLogins = positiveInt(options.maxFailedLogins, 5);
    this.#lockoutMs = positiveInt(options.lockoutMs, 15 * 60 * 1000);
    this.#scrypt = { ...DEFAULT_SCRYPT, ...options.scrypt };
    for (const value of Object.values(this.#scrypt)) if (!Number.isSafeInteger(value) || value <= 0) throw new AdminAuthError('invalid_input');
  }

  async bootstrapLegacy(input: { username: string; password: string; role?: AdminRole }): Promise<PublicAdminUser> {
    return this.#exclusive(async () => {
      const existing = await this.#storage.query<AdminUserRecord>({ prefix: USER_PREFIX, limit: 1 });
      if (existing.length > 0) return publicUser(existing[0]!.value);
      return publicUser(await this.#createRecord(input.username, input.password, input.role ?? 'admin', true));
    });
  }

  async createUser(input: { username: string; password: string; role: AdminRole; enabled?: boolean }): Promise<PublicAdminUser> {
    return this.#exclusive(async () => publicUser(await this.#createRecord(input.username, input.password, input.role, input.enabled ?? true)));
  }

  async getUser(username: string): Promise<PublicAdminUser | undefined> {
    const user = await this.#getRecord(username);
    return user ? publicUser(user) : undefined;
  }

  async listUsers(): Promise<PublicAdminUser[]> {
    const rows = await this.#storage.query<AdminUserRecord>({ prefix: USER_PREFIX });
    return rows.map((row) => publicUser(row.value)).sort((a, b) => a.normalizedUsername.localeCompare(b.normalizedUsername));
  }

  async updateUser(username: string, patch: { username?: string; role?: AdminRole; enabled?: boolean }): Promise<PublicAdminUser> {
    return this.#exclusive(async () => {
      const current = await this.#requireRecord(username);
      const nextNormalized = patch.username === undefined ? current.normalizedUsername : normalizeAdminUsername(patch.username);
      if (nextNormalized !== current.normalizedUsername && await this.#storage.get<AdminUserRecord>(userKey(nextNormalized))) throw new AdminAuthError('username_taken');
      const nextRole = patch.role ?? current.role;
      const nextEnabled = patch.enabled ?? current.enabled;
      if (isEnabledAdmin(current) && (!nextEnabled || !PRIVILEGED_ROLES.has(nextRole))) await this.#protectLastAdmin(current.id);
      const securityChanged = nextRole !== current.role || nextEnabled !== current.enabled || nextNormalized !== current.normalizedUsername;
      const updated: AdminUserRecord = {
        ...current,
        username: patch.username?.trim() || current.username,
        normalizedUsername: nextNormalized,
        role: nextRole,
        enabled: nextEnabled,
        authVersion: current.authVersion + (securityChanged ? 1 : 0),
        updatedAt: this.#now(),
      };
      await this.#storage.save(userKey(nextNormalized), updated);
      if (nextNormalized !== current.normalizedUsername) await this.#storage.delete(userKey(current.normalizedUsername));
      return publicUser(updated);
    });
  }

  async changePassword(username: string, password: string): Promise<void> {
    await this.#exclusive(async () => {
      const current = await this.#requireRecord(username);
      current.password = await this.#hashPassword(password);
      current.authVersion += 1;
      current.failedLoginCount = 0;
      delete current.lockedUntil;
      current.updatedAt = this.#now();
      await this.#storage.save(userKey(current.normalizedUsername), current);
    });
  }

  async deleteUser(username: string): Promise<void> {
    await this.#exclusive(async () => {
      const current = await this.#requireRecord(username);
      if (isEnabledAdmin(current)) await this.#protectLastAdmin(current.id);
      await this.#storage.delete(userKey(current.normalizedUsername));
    });
  }

  async login(username: string, password: string): Promise<{ token: string; auth: AuthenticatedAdmin }> {
    return this.#exclusive(async () => {
      const now = this.#now();
      const normalized = normalizeAdminUsername(username);
      const user = await this.#storage.get<AdminUserRecord>(userKey(normalized));
      if (!user) {
        await this.#verifyPassword(password, await this.#getDummyHash());
        throw new AdminAuthError('invalid_credentials');
      }
      if (user.lockedUntil && user.lockedUntil > now) throw new AdminAuthError('locked');
      const valid = await this.#verifyPassword(password, user.password);
      if (!valid) {
        user.failedLoginCount += 1;
        if (user.failedLoginCount >= this.#maxFailedLogins) {
          user.lockedUntil = now + this.#lockoutMs;
          user.failedLoginCount = 0;
        }
        user.updatedAt = now;
        await this.#storage.save(userKey(normalized), user);
        throw new AdminAuthError(user.lockedUntil && user.lockedUntil > now ? 'locked' : 'invalid_credentials');
      }
      if (!user.enabled) throw new AdminAuthError('disabled');
      user.failedLoginCount = 0;
      delete user.lockedUntil;
      user.lastLoginAt = now;
      user.updatedAt = now;
      await this.#storage.save(userKey(normalized), user);
      const token = `mohos_${this.#randomBytes(32).toString('base64url')}`;
      const tokenHash = tokenDigest(token);
      const session: AdminSessionRecord = {
        kind: 'admin-session', id: this.#randomBytes(16).toString('hex'), tokenHash,
        userId: user.id, normalizedUsername: normalized, authVersion: user.authVersion,
        createdAt: now, expiresAt: now + this.#sessionTtlMs, lastSeenAt: now,
      };
      await this.#storage.save(sessionKey(tokenHash), session, Math.ceil(this.#sessionTtlMs / 1000));
      return { token, auth: this.#authenticated(user, session) };
    });
  }

  async authenticate(token: string): Promise<AuthenticatedAdmin | undefined> {
    if (!token || token.length > 512) return undefined;
    const hash = tokenDigest(token);
    const session = await this.#storage.get<AdminSessionRecord>(sessionKey(hash));
    if (!session || session.expiresAt <= this.#now()) return undefined;
    const user = await this.#storage.get<AdminUserRecord>(userKey(session.normalizedUsername));
    if (!user || !user.enabled || user.id !== session.userId || user.authVersion !== session.authVersion) {
      await this.#storage.delete(sessionKey(hash));
      return undefined;
    }
    session.lastSeenAt = this.#now();
    await this.#storage.save(sessionKey(hash), session, Math.max(1, Math.ceil((session.expiresAt - this.#now()) / 1000)));
    return this.#authenticated(user, session);
  }

  async revokeSession(token: string): Promise<void> { if (token) await this.#storage.delete(sessionKey(tokenDigest(token))); }

  async revokeUserSessions(userId: string): Promise<number> {
    const rows = await this.#storage.query<AdminSessionRecord>({ prefix: SESSION_PREFIX });
    let removed = 0;
    for (const row of rows) if (row.value.userId === userId) { await this.#storage.delete(row.key); removed += 1; }
    return removed;
  }

  async #createRecord(username: string, password: string, role: AdminRole, enabled: boolean): Promise<AdminUserRecord> {
    const normalized = normalizeAdminUsername(username);
    if (await this.#storage.get(userKey(normalized))) throw new AdminAuthError('username_taken');
    const now = this.#now();
    const user: AdminUserRecord = {
      kind: 'admin-user', id: this.#randomBytes(16).toString('hex'), username: username.trim(), normalizedUsername: normalized,
      role, enabled, password: await this.#hashPassword(password), authVersion: 1, failedLoginCount: 0,
      createdAt: now, updatedAt: now,
    };
    await this.#storage.save(userKey(normalized), user);
    return user;
  }

  async #hashPassword(password: string): Promise<ScryptPasswordHash> {
    if (password.length < 10 || Buffer.byteLength(password, 'utf8') > 1024) throw new AdminAuthError('invalid_input');
    const salt = this.#randomBytes(16);
    const hash = await deriveScrypt(password, salt, this.#scrypt);
    return { algorithm: 'scrypt', version: PASSWORD_VERSION, ...this.#scrypt, salt: salt.toString('base64'), hash: hash.toString('base64') };
  }

  async #verifyPassword(password: string, encoded: ScryptPasswordHash): Promise<boolean> {
    try {
      if (encoded.algorithm !== 'scrypt' || encoded.version !== PASSWORD_VERSION
        || !validStoredScrypt(encoded)) return false;
      const salt = Buffer.from(encoded.salt, 'base64');
      const expected = Buffer.from(encoded.hash, 'base64');
      if (salt.length < 16 || salt.length > 64 || expected.length !== encoded.keyLength) return false;
      const actual = await deriveScrypt(password, salt, encoded);
      return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    } catch { return false; }
  }

  async #getDummyHash(): Promise<ScryptPasswordHash> { return this.#dummyHash ??= this.#hashPassword('dummy-password-never-valid'); }
  async #getRecord(username: string): Promise<AdminUserRecord | undefined> { return this.#storage.get(userKey(normalizeAdminUsername(username))); }
  async #requireRecord(username: string): Promise<AdminUserRecord> { const user = await this.#getRecord(username); if (!user) throw new AdminAuthError('not_found'); return user; }
  async #protectLastAdmin(excludingId: string): Promise<void> {
    const users = await this.#storage.query<AdminUserRecord>({ prefix: USER_PREFIX });
    if (!users.some(({ value }) => value.id !== excludingId && isEnabledAdmin(value))) throw new AdminAuthError('last_admin');
  }
  #authenticated(user: AdminUserRecord, session: AdminSessionRecord): AuthenticatedAdmin {
    return { principal: { id: user.id, role: user.role, enabled: user.enabled }, user: publicUser(user), session: publicSession(session) };
  }
  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#mutation;
    let release!: () => void;
    this.#mutation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
}

function deriveScrypt(password: string, salt: Buffer, config: ScryptConfig): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, config.keyLength, { N: config.N, r: config.r, p: config.p, maxmem: 128 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error); else resolve(key);
    });
  });
}

function validStoredScrypt(value: ScryptConfig): boolean {
  return Number.isSafeInteger(value.N) && value.N >= 1024 && value.N <= 1_048_576 && (value.N & (value.N - 1)) === 0
    && Number.isSafeInteger(value.r) && value.r >= 1 && value.r <= 32
    && Number.isSafeInteger(value.p) && value.p >= 1 && value.p <= 16
    && Number.isSafeInteger(value.keyLength) && value.keyLength >= 16 && value.keyLength <= 128;
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
function isEnabledAdmin(user: Pick<AdminUserRecord, 'enabled'|'role'>): boolean { return user.enabled && PRIVILEGED_ROLES.has(user.role); }
