import type { AdminMe } from './types';

const SESSION_KEY = 'moho-admin-session';

function sessionStore(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}

let sessionToken = sessionStore()?.getItem(SESSION_KEY) ?? '';
let unauthorizedHandler: (() => void) | undefined;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly payload: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function setUnauthorizedHandler(handler: (() => void) | undefined): void {
  unauthorizedHandler = handler;
}

export function setSessionToken(token: string): void {
  sessionToken = token;
  const storage = sessionStore();
  if (token) storage?.setItem(SESSION_KEY, token);
  else storage?.removeItem(SESSION_KEY);
}

export function getSessionToken(): string {
  return sessionToken;
}

async function parseResponse(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export async function api<T = Record<string, unknown>>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('accept', 'application/json');
  if (options.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  if (sessionToken) headers.set('authorization', `Bearer ${sessionToken}`);

  let response: Response;
  try {
    response = await fetch(`/api${path.startsWith('/') ? path : `/${path}`}`, {
      ...options,
      headers,
    });
  } catch {
    throw new ApiError('无法连接 MohoBot 管理服务', 0);
  }

  const payload = await parseResponse(response);
  if (response.status === 401) {
    setSessionToken('');
    unauthorizedHandler?.();
    throw new ApiError('登录会话已过期，请重新登录', 401, payload);
  }
  if (!response.ok) {
    throw new ApiError(
      String(payload.error ?? payload.message ?? response.statusText ?? '请求失败'),
      response.status,
      payload,
    );
  }
  return payload as T;
}

export async function loginWithPassword(username: string, password: string): Promise<string> {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const payload = await parseResponse(response);
  if (!response.ok) throw new ApiError(String(payload.error ?? '登录失败'), response.status, payload);
  const token = String(payload.token ?? payload.sessionToken ?? payload.accessToken ?? '');
  if (!token) throw new ApiError('登录响应没有返回 Session Token', 500, payload);
  setSessionToken(token);
  return token;
}

export async function loginWithBootstrapToken(token: string): Promise<string> {
  const response = await fetch('/api/auth/session', {
    method: 'POST',
    headers: { accept: 'application/json', 'x-admin-token': token },
  });
  const payload = await parseResponse(response);
  if (!response.ok) throw new ApiError(String(payload.error ?? '初始化令牌无效'), response.status, payload);
  const session = String(payload.token ?? payload.sessionToken ?? payload.accessToken ?? '');
  if (!session) throw new ApiError('令牌交换响应缺少 Session Token', 500, payload);
  setSessionToken(session);
  return session;
}

export async function currentAdmin(): Promise<AdminMe> {
  return api<AdminMe>('/auth/me');
}

/* ------------------------------------------------------------------ *
 * First-run deployment setup (unauthenticated, loopback trust model). *
 * ------------------------------------------------------------------ */

export interface SetupStatus {
  ok?: boolean;
  initialized: boolean;
  users: number;
}

export async function fetchSetupStatus(): Promise<SetupStatus> {
  const response = await fetch('/api/setup/status', { headers: { accept: 'application/json' } });
  const payload = await parseResponse(response);
  if (!response.ok) throw new ApiError(String(payload.error ?? '无法读取初始化状态'), response.status, payload);
  return { initialized: payload.initialized === true, users: Number(payload.users ?? 0), ok: payload.ok === true };
}

export interface SetupInitResult {
  token: string;
  masterToken: string;
  username?: string;
}

export async function initializeDeployment(username: string, password: string): Promise<SetupInitResult> {
  const response = await fetch('/api/setup/init', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const payload = await parseResponse(response);
  if (!response.ok) throw new ApiError(String(payload.error ?? payload.message ?? '初始化失败'), response.status, payload);
  const token = String(payload.token ?? payload.sessionToken ?? '');
  const masterToken = String(payload.masterToken ?? '');
  if (!token) throw new ApiError('初始化响应缺少会话令牌', 500, payload);
  setSessionToken(token);
  return { token, masterToken, username };
}

export function body(value: unknown): string {
  return JSON.stringify(value);
}

export function hasPermission(permissions: string[], permission: string): boolean {
  return permissions.includes(permission);
}

/** Uses the server-issued confirmation nonce; the client never bypasses route policy. */
export async function confirmedRequest<T = Record<string, unknown>>(
  path: string,
  options: RequestInit,
  payload: unknown,
  description: string,
): Promise<T> {
  const phrase = window.prompt(`${description}\n\n这是受保护的管理操作。输入“确认”继续：`);
  if (phrase !== '确认') throw new ApiError('操作已取消', 0);

  const issued = await api<{ confirmation?: { nonce?: string }; nonce?: string }>('/confirmations', {
    method: 'POST',
    body: body({ method: options.method ?? 'POST', path, body: payload }),
  });
  const nonce = issued.confirmation?.nonce ?? issued.nonce;
  if (!nonce) throw new ApiError('确认服务没有返回 nonce', 500);
  const headers = new Headers(options.headers);
  headers.set('X-Admin-Confirmation', nonce);
  return api<T>(path, { ...options, headers });
}
