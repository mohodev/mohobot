import { runSetup } from '../setup.js';
import { AdminAuthError, type AdminAuthService, type AuthenticatedAdmin } from './auth-service.js';

export interface SetupStatus {
  /** true once a deployment master token exists (data/.env.local MOHO_ADMIN_TOKEN). */
  initialized: boolean;
  /** number of admin accounts in the directory. */
  users: number;
}

export type SetupErrorCode = 'already_initialized' | 'invalid_input' | 'setup_failed';

export class SetupError extends Error {
  constructor(readonly code: SetupErrorCode, message?: string) {
    super(message ?? code);
  }
}

export interface SetupInitResult {
  /** bearer session for the freshly created administrator (auto-login). */
  token: string;
  auth: AuthenticatedAdmin;
  /**
   * The generated deployment master token (break-glass recovery credential,
   * persisted to data/.env.local). Returned exactly once, at initialization.
   */
  masterToken: string;
}

export interface SetupControlOptions {
  rootDir: string;
  auth: AdminAuthService;
  /** live read of the deployment master token (empty string before setup). */
  token: () => string;
}

/**
 * First-run deployment initialization behind the admin WebUI.
 *
 * The pre-setup trust model matches the CLI: whoever reaches the loopback
 * admin port first owns the deployment. Once a master token exists, init is
 * permanently closed (status().initialized) and only the normal auth
 * endpoints remain.
 */
export class SetupControl {
  readonly #opts: SetupControlOptions;

  constructor(opts: SetupControlOptions) {
    this.#opts = opts;
  }

  async status(): Promise<SetupStatus> {
    const users = await this.#opts.auth.listUsers().catch(() => [] as unknown[]);
    return { initialized: this.#opts.token().trim().length > 0, users: users.length };
  }

  async init(input: Record<string, unknown>): Promise<SetupInitResult> {
    if (this.#opts.token().trim()) throw new SetupError('already_initialized');
    const username = String(input.username ?? '').trim();
    const password = String(input.password ?? '');
    if (username.length < 1 || username.length > 64) {
      throw new SetupError('invalid_input', '用户名长度需为 1-64 字符');
    }
    if (password.length < 10 || Buffer.byteLength(password, 'utf8') > 1024) {
      throw new SetupError('invalid_input', '密码至少 10 位');
    }
    let masterToken: string;
    try {
      const result = await runSetup({ rootDir: this.#opts.rootDir, nonInteractive: true });
      masterToken = result.adminToken;
    } catch (error) {
      // runSetup writes .env.local with flag wx: a concurrent initializer loses
      // the race with EEXIST, which means the deployment is already taken.
      if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') throw new SetupError('already_initialized');
      throw new SetupError('setup_failed', error instanceof Error ? error.message : String(error));
    }
    if (!masterToken) throw new SetupError('setup_failed', 'master token unavailable after setup');
    try {
      await this.#opts.auth.createUser({ username, password, role: 'developer', enabled: true });
    } catch (error) {
      if (error instanceof AdminAuthError && error.code === 'invalid_input') {
        throw new SetupError('invalid_input', '用户名包含非法字符');
      }
      if (error instanceof AdminAuthError && error.code === 'username_taken') {
        throw new SetupError('invalid_input', '用户名已被占用');
      }
      throw error;
    }
    const session = await this.#opts.auth.login(username, password);
    return { token: session.token, auth: session.auth, masterToken };
  }
}
