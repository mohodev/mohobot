import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/render';
import { jsonResponse } from '../test/fixtures';
import { setSessionToken } from '../lib/api';
import { Login } from './login';

beforeEach(() => {
  setSessionToken('');
});

afterEach(() => {
  setSessionToken('');
  vi.unstubAllGlobals();
});

function stubFetch(routes: Record<string, unknown>) {
  const mock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, 'http://localhost');
    const hit = routes[url.pathname];
    if (hit === undefined) return jsonResponse({ error: 'not found' }, 404);
    if (typeof hit === 'function') return (hit as () => Response)();
    return jsonResponse(hit);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('Login', () => {
  it('shows the login form on an initialized deployment', async () => {
    stubFetch({ '/api/setup/status': { ok: true, initialized: true, users: 2 } });
    renderWithProviders(<Login onLoggedIn={() => undefined} />);
    expect(await screen.findByText('欢迎回来')).toBeInTheDocument();
  });

  it('shows the first-run setup wizard when the deployment is uninitialized', async () => {
    stubFetch({ '/api/setup/status': { ok: true, initialized: false, users: 0 } });
    renderWithProviders(<Login onLoggedIn={() => undefined} />);
    await waitFor(() => expect(screen.getByText('初始化部署')).toBeInTheDocument());
    expect(screen.getByText(/此操作只能执行一次/)).toBeInTheDocument();
  });

  it('initializes the deployment and surfaces the one-time master token', async () => {
    const onLoggedIn = vi.fn();
    stubFetch({
      '/api/setup/status': { ok: true, initialized: false, users: 0 },
      '/api/setup/init': () => jsonResponse({ ok: true, token: 'session-token', masterToken: 'master-abc', auth: {} }, 201),
      '/api/auth/me': { ok: true, permissions: ['status.read'], auth: { principal: { id: 'u1', role: 'developer', enabled: true } } },
    });
    renderWithProviders(<Login onLoggedIn={onLoggedIn} />);
    const userInput = await screen.findByLabelText('用户名');
    const user = userEvent.setup();
    await user.type(userInput, 'owner');
    await user.type(screen.getByLabelText('密码'), 'supersecret1');
    await user.click(screen.getAllByRole('button', { name: '创建管理员并初始化' })[0]!);
    expect(await screen.findByText(/保存部署主令牌/)).toBeInTheDocument();
    expect(screen.getByText('master-abc')).toBeInTheDocument();
  });
});
