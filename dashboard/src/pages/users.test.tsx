import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../test/render';
import { mockFetch, jsonResponse } from '../test/fixtures';
import { setSessionToken } from '../lib/api';
import { Users } from './users';

type Routes = Parameters<typeof mockFetch>[0];

function setup(routes: Routes) {
  vi.stubGlobal('fetch', mockFetch(routes));
}

function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    username: 'alice',
    normalizedUsername: 'alice',
    role: 'admin',
    enabled: true,
    authVersion: 1,
    failedLoginCount: 0,
    createdAt: Date.now() - 86_400_000,
    updatedAt: Date.now() - 3_600_000,
    ...overrides,
  };
}

const FULL_PERMISSIONS = [
  'users.read', 'users.create', 'users.update', 'users.disable', 'users.role.assign',
  'users.credentials.rotate', 'sessions.read', 'sessions.revoke', 'tokens.read',
  'tokens.create', 'tokens.revoke',
];

beforeEach(() => {
  setSessionToken('test-token');
  vi.spyOn(window, 'prompt').mockReturnValue('确认');
});

afterEach(() => {
  setSessionToken('');
  vi.unstubAllGlobals();
});

describe('Users', () => {
  it('renders administrator rows from the mocked directory', async () => {
    setup({
      'GET /api/admin/users': {
        users: [
          userRow({ id: 'user-1', username: 'alice', role: 'admin', enabled: true }),
          userRow({ id: 'user-2', username: 'bob', role: 'viewer', enabled: false, lastLoginAt: Date.now() - 120_000 }),
        ],
      },
    });

    renderWithProviders(<Users permissions={FULL_PERMISSIONS} />);

    expect(await screen.findByText('alice')).toBeInTheDocument();
    expect(screen.getByText('bob')).toBeInTheDocument();
    expect(screen.getByText('管理员 (admin)')).toBeInTheDocument();
    expect(screen.getByText('只读 (viewer)')).toBeInTheDocument();
    expect(screen.getByText('已禁用')).toBeInTheDocument();
    expect(screen.getByText('2 个账号')).toBeInTheDocument();
  });

  it('shows the empty state when the directory is empty', async () => {
    setup({ 'GET /api/admin/users': { users: [] } });

    renderWithProviders(<Users permissions={FULL_PERMISSIONS} />);

    expect(await screen.findByText('暂无管理员账号')).toBeInTheDocument();
  });

  it('shows an error state when the directory request fails', async () => {
    setup({ 'GET /api/admin/users': () => jsonResponse({ error: 'boom' }, 500) });

    renderWithProviders(<Users permissions={FULL_PERMISSIONS} />);

    expect(screen.getByText('正在读取数据')).toBeInTheDocument();
    expect(await screen.findByText(/boom/)).toBeInTheDocument();
  });

  it('runs the confirmation flow before creating an account', async () => {
    const fetchMock = mockFetch({
      'GET /api/admin/users': { users: [] },
      'POST /api/confirmations': { confirmation: { nonce: 'nonce-1' } },
      'POST /api/admin/users': { user: userRow({ id: 'user-9', username: 'ops-alice', role: 'viewer' }) },
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(<Users permissions={FULL_PERMISSIONS} />);
    fireEvent.click(await screen.findByRole('button', { name: /新建账号/ }));

    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'ops-alice' } });
    fireEvent.change(screen.getByLabelText('初始密码'), { target: { value: 'super-secret-password' } });
    fireEvent.click(screen.getByRole('button', { name: '创建账号' }));

    await waitFor(() => {
      const calls = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(calls).toContain('/api/confirmations');
      expect(calls).toContain('/api/admin/users');
    });

    const posted = fetchMock.mock.calls.find(([url, init]) => String(url) === '/api/admin/users' && init?.method === 'POST');
    expect(posted).toBeTruthy();
    expect(JSON.parse(String(posted?.[1]?.body))).toMatchObject({
      username: 'ops-alice',
      password: 'super-secret-password',
      role: 'viewer',
      enabled: true,
    });
    const headers = new Headers(posted?.[1]?.headers);
    expect(headers.get('X-Admin-Confirmation')).toBe('nonce-1');
  });

  it('surfaces a 403 role-escalation error from the server', async () => {
    setup({
      'GET /api/admin/users': { users: [] },
      'POST /api/confirmations': { confirmation: { nonce: 'nonce-2' } },
      'POST /api/admin/users': () => jsonResponse({ error: 'cannot assign higher role' }, 403),
    });

    renderWithProviders(<Users permissions={FULL_PERMISSIONS} />);
    fireEvent.click(await screen.findByRole('button', { name: /新建账号/ }));
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'ops-eve' } });
    fireEvent.change(screen.getByLabelText('初始密码'), { target: { value: 'super-secret-password' } });
    fireEvent.click(screen.getByRole('button', { name: '创建账号' }));

    expect(await screen.findByText(/权限不足（403）/)).toBeInTheDocument();
  });

  it('revokes a session directly without a confirmation prompt', async () => {
    const fetchMock = mockFetch({
      'GET /api/auth/sessions': {
        sessions: [{ id: 'sess-1', normalizedUsername: 'alice', role: 'admin', createdAt: Date.now() - 60_000, lastSeenAt: Date.now(), current: true }],
      },
      'DELETE /api/auth/sessions/sess-1': { revoked: true },
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(<Users permissions={FULL_PERMISSIONS} />);
    fireEvent.click(await screen.findByRole('tab', { name: /会话/ }));
    fireEvent.click(await screen.findByRole('button', { name: /吊销/ }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url, init]) => String(url) === '/api/auth/sessions/sess-1' && init?.method === 'DELETE')).toBe(true);
    });
    expect(window.prompt).not.toHaveBeenCalled();
  });

  it('reveals the one-time temporary token value in a modal', async () => {
    const fetchMock = mockFetch({
      'GET /api/auth/temporary-tokens': { tokens: [] },
      'POST /api/confirmations': { confirmation: { nonce: 'nonce-3' } },
      'POST /api/auth/temporary-tokens': {
        token: 'moht_one_time_value_123',
        record: { id: 'token-1', label: '临时验收', role: 'viewer', createdBy: 'user-1', createdAt: Date.now(), expiresAt: Date.now() + 3_600_000 },
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(<Users permissions={FULL_PERMISSIONS} />);
    fireEvent.click(await screen.findByRole('tab', { name: /临时令牌/ }));
    fireEvent.click(await screen.findByRole('button', { name: /新建令牌/ }));

    fireEvent.change(screen.getByLabelText('令牌标签'), { target: { value: '临时验收' } });
    fireEvent.change(screen.getByLabelText('有效期'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: '创建令牌' }));

    expect(await screen.findByText('moht_one_time_value_123')).toBeInTheDocument();
    expect(screen.getByText(/仅显示这一次/)).toBeInTheDocument();

    const posted = fetchMock.mock.calls.find(([url, init]) => String(url) === '/api/auth/temporary-tokens' && init?.method === 'POST');
    expect(JSON.parse(String(posted?.[1]?.body))).toMatchObject({ label: '临时验收', role: 'viewer', ttlMinutes: 30 });
  });

  it('hides mutating controls without the matching permissions', async () => {
    setup({ 'GET /api/admin/users': { users: [userRow()] } });

    renderWithProviders(<Users permissions={['users.read']} />);

    expect(await screen.findByText('alice')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /新建账号/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /重置密码/ })).toBeNull();
    expect(screen.getByText(/只读：缺少 users.create 权限/)).toBeInTheDocument();
  });
});
