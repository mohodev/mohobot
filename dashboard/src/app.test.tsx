import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { renderWithProviders } from './test/render';
import { mockFetch } from './test/fixtures';
import { setSessionToken } from './lib/api';
import { App } from './app';

beforeEach(() => {
  window.location.hash = '';
  window.sessionStorage.clear();
});

afterEach(() => {
  setSessionToken('');
  window.location.hash = '';
  vi.unstubAllGlobals();
});

/** An authenticated operator: read scopes + a couple of write scopes. */
function authMe(permissions: string[]) {
  return {
    ok: true,
    permissions,
    auth: { principal: { id: 'op-1', username: 'operator', role: 'operator', enabled: true } },
  };
}

describe('App shell integration', () => {
  it('shows the login screen when there is no session token', async () => {
    vi.stubGlobal('fetch', mockFetch({ 'GET /api/setup/status': { ok: true, initialized: true, users: 1 } }));
    renderWithProviders(<App />);
    expect(await screen.findByText('欢迎回来')).toBeInTheDocument();
  });

  it('filters navigation to the principal permissions and routes to overview', async () => {
    setSessionToken('token');
    vi.stubGlobal('fetch', mockFetch({
      'GET /api/auth/me': authMe(['status.read', 'gateway.read']),
      'GET /api/status': { now: new Date().toISOString(), bots: [] },
      'GET /api/admin/health': { health: { runtime: 'idle', bots: 0 } },
      'GET /api/metrics': { metrics: {} },
    }));

    renderWithProviders(<App />);

    // Overview renders after auth.
    const nav = await screen.findByRole('navigation');
    await waitFor(() => expect(within(nav).getByText('运行总览')).toBeInTheDocument());
    expect(within(nav).getByText('机器人')).toBeInTheDocument();
    // A scope the operator lacks (characters.read) must not appear.
    expect(within(nav).queryByText('角色档案')).not.toBeInTheDocument();
    expect(within(nav).queryByText('管理员')).not.toBeInTheDocument();
  });

  it('redirects away from a view the principal cannot access', async () => {
    setSessionToken('token');
    window.location.hash = '#/users';
    vi.stubGlobal('fetch', mockFetch({
      'GET /api/auth/me': authMe(['status.read', 'gateway.read']),
      'GET /api/status': { now: new Date().toISOString(), bots: [] },
      'GET /api/admin/health': { health: { runtime: 'idle', bots: 0 } },
      'GET /api/metrics': { metrics: {} },
    }));

    renderWithProviders(<App />);

    // No users.read, so the app must fall back to the first allowed view.
    await waitFor(() => expect(window.location.hash).toBe('#/overview'));
    const nav = screen.getByRole('navigation');
    expect(within(nav).getByText('运行总览')).toBeInTheDocument();
  });

  it('logs out and returns to the login screen', async () => {
    setSessionToken('token');
    vi.stubGlobal('fetch', mockFetch({
      'POST /api/auth/logout': { ok: true, loggedOut: true },
      'GET /api/auth/me': authMe(['status.read']),
      'GET /api/status': { now: new Date().toISOString(), bots: [] },
      'GET /api/admin/health': { health: { runtime: 'idle' } },
      'GET /api/metrics': { metrics: {} },
    }));

    renderWithProviders(<App />);
    const nav = await screen.findByRole('navigation');
    await waitFor(() => expect(within(nav).getByText('运行总览')).toBeInTheDocument());
    const logoutButton = screen.getByTitle('退出登录');
    logoutButton.click();
    expect(await screen.findByText('欢迎回来')).toBeInTheDocument();
  });
});
