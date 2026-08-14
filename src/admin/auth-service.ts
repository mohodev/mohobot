import crypto from 'node:crypto';
import type { Storage } from '../storage/types.js';
import type { AdminPrincipal, AdminRole } from './rbac.js';

const USER_PREFIX = 'admin-user:';
const SESSION_PREFIX = 'admin-session:';
const TEMP_TOKEN_PREFIX = 'admin-temp-token:';
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
  recordVersion: 1;
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
  recordVersion: 1;
  id: string;
  tokenHash: string;
  userId: string;
  normalizedUsername: string;
  authVersion: number;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
}

export interface AdminTemporaryTokenRecord {
  kind:'admin-temporary-token';recordVersion:1;id:string;tokenHash:string;label:string;role:AdminRole;createdBy:string;createdAt:number;expiresAt:number;lastUsedAt?:number;revokedAt?:number;
}
export interface PublicTemporaryToken {id:string;label:string;role:AdminRole;createdBy:string;createdAt:number;expiresAt:number;lastUsedAt?:number;revokedAt?:number;}

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
  session: Omit<AdminSessionRecord, 'tokenHash'|'recordVersion'>;
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
  constructor(readonly code: 'invalid_credentials'|'locked'|'disabled'|'not_found'|'username_taken'|'last_admin'|'invalid_input'|'unsupported_record') {
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
function temporaryTokenKey(tokenHash:string):string{return `${TEMP_TOKEN_PREFIX}${tokenHash}`;}
function publicTemporaryToken(record:AdminTemporaryTokenRecord):PublicTemporaryToken{const{kind:_kind,recordVersion:_version,tokenHash:_hash,...safe}=record;return safe;}
function publicUser(user: AdminUserRecord): PublicAdminUser {
  const { password: _password, kind: _kind, recordVersion: _recordVersion, ...safe } = user;
  return safe;
}
function publicSession(session: AdminSessionRecord): Omit<AdminSessionRecord, 'tokenHash'|'recordVersion'> {
  const { tokenHash: _tokenHash, recordVersion: _recordVersion, ...safe } = session;
  return safe;
}
function tokenDigest(token: string): string { return crypto.createHash('sha256').update(token, 'utf8').digest('hex'); }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function safeInt(value: unknown, min = 0): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= min; }
function role(value: unknown): value is AdminRole { return value === 'viewer' || value === 'operator' || value === 'admin' || value === 'developer'; }
function string(value: unknown, max = 1024): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max; }
function decodePassword(value: unknown): ScryptPasswordHash | undefined {
  if (!object(value) || value.algorithm !== 'scrypt' || value.version !== 1 || !safeInt(value.N, 1)
    || !safeInt(value.r, 1) || !safeInt(value.p, 1) || !safeInt(value.keyLength, 1)
    || !string(value.salt, 256) || !string(value.hash, 512)) return undefined;
  return value as unknown as ScryptPasswordHash;
}
function decodeUser(value: unknown, expectedNormalized?: string): AdminUserRecord | undefined {
  if (!object(value) || (value.recordVersion !== undefined && value.recordVersion !== 1)
    || value.kind !== 'admin-user' || !string(value.id, 128) || !string(value.username, 128)
    || !string(value.normalizedUsername, 256) || (expectedNormalized !== undefined && value.normalizedUsername !== expectedNormalized)
    || !role(value.role) || typeof value.enabled !== 'boolean' || !safeInt(value.authVersion, 1)
    || !safeInt(value.failedLoginCount) || !safeInt(value.createdAt) || !safeInt(value.updatedAt)
    || (value.lockedUntil !== undefined && !safeInt(value.lockedUntil)) || (value.lastLoginAt !== undefined && !safeInt(value.lastLoginAt))) return undefined;
  const password = decodePassword(value.password); if (!password) return undefined;
  return { ...(value as unknown as AdminUserRecord), recordVersion: 1, password };
}
function decodeTemporaryToken(value:unknown,expectedHash?:string):AdminTemporaryTokenRecord|undefined{if(!object(value)||(value.recordVersion!==undefined&&value.recordVersion!==1)||value.kind!=='admin-temporary-token'||!string(value.id,128)||!string(value.tokenHash,128)||(expectedHash!==undefined&&value.tokenHash!==expectedHash)||!string(value.label,128)||!string(value.createdBy,128)||!role(value.role)||!safeInt(value.createdAt)||!safeInt(value.expiresAt)||(value.lastUsedAt!==undefined&&!safeInt(value.lastUsedAt))||(value.revokedAt!==undefined&&!safeInt(value.revokedAt)))return undefined;return{...(value as unknown as AdminTemporaryTokenRecord),recordVersion:1};}
function decodeSession(value: unknown, expectedHash?: string): AdminSessionRecord | undefined {
  if (!object(value) || (value.recordVersion !== undefined && value.recordVersion !== 1)
    || value.kind !== 'admin-session' || !string(value.id, 128) || !string(value.tokenHash, 128)
    || (expectedHash !== undefined && value.tokenHash !== expectedHash) || !string(value.userId, 128)
    || !string(value.normalizedUsername, 256) || !safeInt(value.authVersion, 1)
    || !safeInt(value.createdAt) || !safeInt(value.expiresAt) || !safeInt(value.lastSeenAt)) return undefined;
  return { ...(value as unknown as AdminSessionRecord), recordVersion: 1 };
}

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
      const existing = await this.#storage.query<unknown>({ prefix: USER_PREFIX, limit: 1 });
      if (existing.length > 0) {
        const decoded = decodeUser(existing[0]!.value);
        if (!decoded) throw new AdminAuthError('unsupported_record');
        return publicUser(decoded);
      }
      return publicUser(await this.#createRecord(input.username, input.password, input.role ?? 'admin', true));
    });
  }

  /** Create a break-glass session after AdminServer verifies the deployment master token. */
  async bootstrapSession(input: { username: string; initialPassword: string }): Promise<{ token: string; auth: AuthenticatedAdmin }> {
    return this.#exclusive(async () => {
      const normalized = normalizeAdminUsername(input.username);
      const raw = await this.#storage.get<unknown>(userKey(normalized));
      let user = raw === undefined ? undefined : decodeUser(raw, normalized);
      if (raw !== undefined && !user) throw new AdminAuthError('unsupported_record');
      if (!user) user = await this.#createRecord(input.username, input.initialPassword, 'admin', true);
      if (!user.enabled) throw new AdminAuthError('disabled');
      return this.#createSession(user);
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
    const rows = await this.#storage.query<unknown>({ prefix: USER_PREFIX });
    return rows.flatMap((row) => { const user = decodeUser(row.value); return user ? [publicUser(user)] : []; })
      .sort((a, b) => a.normalizedUsername.localeCompare(b.normalizedUsername));
  }

  async resolveUserIdentifier(identifier: string): Promise<PublicAdminUser | undefined> {
    const direct=await this.getUser(identifier);if(direct)return direct;
    return (await this.listUsers()).find((user)=>user.id===identifier);
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
      const rawUser = await this.#storage.get<unknown>(userKey(normalized));
      const user = rawUser === undefined ? undefined : decodeUser(rawUser, normalized);
      if (rawUser !== undefined && !user) throw new AdminAuthError('unsupported_record');
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
      return this.#createSession(user);
    });
  }

  async authenticate(token: string): Promise<AuthenticatedAdmin | undefined> {
    if (!token || token.length > 512) return undefined;
    const hash = tokenDigest(token);
    const rawTemporary=await this.#storage.get<unknown>(temporaryTokenKey(hash));
    const temporary=rawTemporary===undefined?undefined:decodeTemporaryToken(rawTemporary,hash);
    if(temporary){if(temporary.revokedAt||temporary.expiresAt<=this.#now())return undefined;temporary.lastUsedAt=this.#now();await this.#storage.save(temporaryTokenKey(hash),temporary,Math.max(1,Math.ceil((temporary.expiresAt-this.#now())/1000)));const principal={id:`temp:${temporary.id}`,role:temporary.role,enabled:true} as AdminPrincipal;const user={id:principal.id,username:temporary.label,normalizedUsername:temporary.label,role:temporary.role,enabled:true,authVersion:1,failedLoginCount:0,createdAt:temporary.createdAt,updatedAt:temporary.createdAt};const session={kind:'admin-session' as const,id:temporary.id,userId:principal.id,normalizedUsername:temporary.label,authVersion:1,createdAt:temporary.createdAt,expiresAt:temporary.expiresAt,lastSeenAt:temporary.lastUsedAt};return{principal,user,session};}
    const rawSession = await this.#storage.get<unknown>(sessionKey(hash));
    const session = rawSession === undefined ? undefined : decodeSession(rawSession, hash);
    if (!session || session.expiresAt <= this.#now()) return undefined;
    const rawUser = await this.#storage.get<unknown>(userKey(session.normalizedUsername));
    const user = rawUser === undefined ? undefined : decodeUser(rawUser, session.normalizedUsername);
    if (!user || !user.enabled || user.id !== session.userId || user.authVersion !== session.authVersion) {
      await this.#storage.delete(sessionKey(hash));
      return undefined;
    }
    session.lastSeenAt = this.#now();
    await this.#storage.save(sessionKey(hash), session, Math.max(1, Math.ceil((session.expiresAt - this.#now()) / 1000)));
    return this.#authenticated(user, session);
  }

  async createTemporaryToken(input:{label:string;role:AdminRole;createdBy:string;ttlMs:number}):Promise<{token:string;record:PublicTemporaryToken}>{return this.#exclusive(async()=>{const label=input.label.trim();if(label.length<1||label.length>128||/[\u0000-\u001f\u007f]/u.test(label))throw new AdminAuthError('invalid_input');if(!Number.isSafeInteger(input.ttlMs)||input.ttlMs<60_000||input.ttlMs>7*24*60*60*1000)throw new AdminAuthError('invalid_input');const now=this.#now();const token=`moht_${this.#randomBytes(32).toString('base64url')}`,tokenHash=tokenDigest(token);const record:AdminTemporaryTokenRecord={kind:'admin-temporary-token',recordVersion:1,id:this.#randomBytes(16).toString('hex'),tokenHash,label,role:input.role,createdBy:input.createdBy,createdAt:now,expiresAt:now+input.ttlMs};await this.#storage.save(temporaryTokenKey(tokenHash),record,Math.ceil(input.ttlMs/1000));return{token,record:publicTemporaryToken(record)};});}
  async listTemporaryTokens():Promise<PublicTemporaryToken[]>{const now=this.#now(),rows=await this.#storage.query<unknown>({prefix:TEMP_TOKEN_PREFIX});return rows.flatMap(row=>{const record=decodeTemporaryToken(row.value);return record&&record.expiresAt>now?[publicTemporaryToken(record)]:[];}).sort((a,b)=>b.createdAt-a.createdAt);}
  async revokeTemporaryToken(id:string):Promise<boolean>{return this.#exclusive(async()=>{const rows=await this.#storage.query<unknown>({prefix:TEMP_TOKEN_PREFIX});const row=rows.find(x=>decodeTemporaryToken(x.value)?.id===id);if(!row)return false;const record=decodeTemporaryToken(row.value)!;if(record.revokedAt)return false;record.revokedAt=this.#now();await this.#storage.save(row.key,record,Math.max(1,Math.ceil((record.expiresAt-this.#now())/1000)));return true;});}
  async revokeSession(token: string): Promise<void> { if (!token) return;const hash=tokenDigest(token);await this.#storage.delete(sessionKey(hash));const raw=await this.#storage.get<unknown>(temporaryTokenKey(hash));const temporary=raw===undefined?undefined:decodeTemporaryToken(raw,hash);if(temporary&&!temporary.revokedAt){temporary.revokedAt=this.#now();await this.#storage.save(temporaryTokenKey(hash),temporary,Math.max(1,Math.ceil((temporary.expiresAt-this.#now())/1000)));} }

  async listSessions(): Promise<Array<Omit<AdminSessionRecord, 'tokenHash'|'recordVersion'>>> {
    const rows = await this.#storage.query<unknown>({ prefix: SESSION_PREFIX });
    const now = this.#now();
    return rows.flatMap((row) => { const session = decodeSession(row.value); return session && session.expiresAt > now ? [publicSession(session)] : []; });
  }

  async revokeSessionById(sessionId: string): Promise<boolean> {
    if (!sessionId || sessionId.length > 128) return false;
    const rows = await this.#storage.query<unknown>({ prefix: SESSION_PREFIX });
    const match = rows.find((row) => decodeSession(row.value)?.id === sessionId);
    if (!match) return false;
    await this.#storage.delete(match.key);
    return true;
  }

  async revokeUserSessions(userId: string): Promise<number> {
    const rows = await this.#storage.query<unknown>({ prefix: SESSION_PREFIX });
    let removed = 0;
    for (const row of rows) if (decodeSession(row.value)?.userId === userId) { await this.#storage.delete(row.key); removed += 1; }
    return removed;
  }

  async #createSession(user: AdminUserRecord): Promise<{ token: string; auth: AuthenticatedAdmin }> {
    const now = this.#now();
    const token = `mohos_${this.#randomBytes(32).toString('base64url')}`;
    const tokenHash = tokenDigest(token);
    const session: AdminSessionRecord = {
      kind: 'admin-session', recordVersion: 1, id: this.#randomBytes(16).toString('hex'), tokenHash,
      userId: user.id, normalizedUsername: user.normalizedUsername, authVersion: user.authVersion,
      createdAt: now, expiresAt: now + this.#sessionTtlMs, lastSeenAt: now,
    };
    await this.#storage.save(sessionKey(tokenHash), session, Math.ceil(this.#sessionTtlMs / 1000));
    return { token, auth: this.#authenticated(user, session) };
  }

  async #createRecord(username: string, password: string, role: AdminRole, enabled: boolean): Promise<AdminUserRecord> {
    const normalized = normalizeAdminUsername(username);
    if (await this.#storage.get(userKey(normalized))) throw new AdminAuthError('username_taken');
    const now = this.#now();
    const user: AdminUserRecord = {
      kind: 'admin-user', recordVersion: 1, id: this.#randomBytes(16).toString('hex'), username: username.trim(), normalizedUsername: normalized,
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
  async #getRecord(username: string): Promise<AdminUserRecord | undefined> {
    const normalized = normalizeAdminUsername(username); const raw = await this.#storage.get<unknown>(userKey(normalized));
    if (raw === undefined) return undefined; const user = decodeUser(raw, normalized); if (!user) throw new AdminAuthError('unsupported_record'); return user;
  }
  async #requireRecord(username: string): Promise<AdminUserRecord> { const user = await this.#getRecord(username); if (!user) throw new AdminAuthError('not_found'); return user; }
  async #protectLastAdmin(excludingId: string): Promise<void> {
    const users = await this.#storage.query<unknown>({ prefix: USER_PREFIX });
    if (!users.some(({ value }) => { const user = decodeUser(value); return Boolean(user && user.id !== excludingId && isEnabledAdmin(user)); })) throw new AdminAuthError('last_admin');
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
