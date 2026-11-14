import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  confirmedRequest,
  getSessionToken,
  loginWithPassword,
  loginWithBootstrapToken,
  setSessionToken,
  setUnauthorizedHandler,
} from './api';

class MemorySessionStorage implements Storage {
  readonly #values = new Map<string, string>();
  get length(): number { return this.#values.size; }
  clear(): void { this.#values.clear(); }
  getItem(key: string): string | null { return this.#values.get(key) ?? null; }
  key(index: number): string | null { return [...this.#values.keys()][index] ?? null; }
  removeItem(key: string): void { this.#values.delete(key); }
  setItem(key: string, value: string): void { this.#values.set(key, String(value)); }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let sessionStorageMock: MemorySessionStorage;
let promptMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sessionStorageMock = new MemorySessionStorage();
  promptMock = vi.fn(() => '确认');
  vi.stubGlobal('window', { sessionStorage: sessionStorageMock, prompt: promptMock });
  setUnauthorizedHandler(undefined);
  setSessionToken('');
});

afterEach(() => {
  setUnauthorizedHandler(undefined);
  setSessionToken('');
  vi.unstubAllGlobals();
});

describe('dashboard API client', () => {
  it('attaches the session token and uses the Admin API prefix', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: true, revision: 7 }));
    vi.stubGlobal('fetch', fetchMock);
    setSessionToken('session-token-1');

    const result = await api<{ ok: boolean; revision: number }>('/status');

    expect(result).toEqual({ ok: true, revision: 7 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/status');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer session-token-1');
    expect(headers.get('accept')).toBe('application/json');
    expect(sessionStorageMock.getItem('moho-admin-session')).toBe('session-token-1');
  });

  it('persists a password-login session token', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ token: 'new-session-token' }, 201));
    vi.stubGlobal('fetch', fetchMock);

    await expect(loginWithPassword('operator', 'test-password')).resolves.toBe('new-session-token');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/auth/login');
    expect(getSessionToken()).toBe('new-session-token');
    expect(sessionStorageMock.getItem('moho-admin-session')).toBe('new-session-token');
  });

  it('exchanges the bootstrap token for an authenticated session', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ sessionToken: 'bootstrap-session' }, 201));
    vi.stubGlobal('fetch', fetchMock);

    await expect(loginWithBootstrapToken('local-bootstrap-key')).resolves.toBe('bootstrap-session');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/auth/session');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('x-admin-token')).toBe('local-bootstrap-key');
    expect(getSessionToken()).toBe('bootstrap-session');
  });

  it('clears an expired session and notifies the application', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: 'unauthorized' }, 401));
    vi.stubGlobal('fetch', fetchMock);
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    setSessionToken('expired-session');

    await expect(api('/status')).rejects.toMatchObject({ statusCode: 401 });

    expect(getSessionToken()).toBe('');
    expect(sessionStorageMock.getItem('moho-admin-session')).toBeNull();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('requires a server-issued confirmation nonce before a protected write', async () => {
    let call = 0;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => {
      call += 1;
      return call === 1
        ? jsonResponse({ confirmation: { nonce: 'nonce-123' } }, 201)
        : jsonResponse({ ok: true, revision: 8 });
    });
    vi.stubGlobal('fetch', fetchMock);
    setSessionToken('admin-session');

    const result = await confirmedRequest<{ ok: boolean; revision: number }>(
      '/config/publish',
      { method: 'POST', body: JSON.stringify({ revision: 8 }) },
      { revision: 8 },
      '发布配置',
    );

    expect(result).toEqual({ ok: true, revision: 8 });
    expect(promptMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const confirmationInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(confirmationInit.body))).toMatchObject({
      method: 'POST',
      path: '/config/publish',
      body: { revision: 8 },
    });

    const writeInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(new Headers(writeInit.headers).get('x-admin-confirmation')).toBe('nonce-123');
    expect(new Headers(writeInit.headers).get('authorization')).toBe('Bearer admin-session');
  });

  it('does not call the API when the confirmation prompt is cancelled', async () => {
    promptMock.mockReturnValue('取消');
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(confirmedRequest('/config/publish', { method: 'POST' }, {}, '发布配置'))
      .rejects.toMatchObject({ statusCode: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
