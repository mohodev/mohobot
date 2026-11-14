import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../test/render';
import { mockFetch, botFixture, jsonResponse } from '../test/fixtures';
import { setSessionToken } from '../lib/api';
import { Bots } from './bots';

function setup(routes: Parameters<typeof mockFetch>[0]) {
  vi.stubGlobal('fetch', mockFetch(routes));
  setSessionToken('test-token');
}

beforeEach(() => {
  setSessionToken('test-token');
});

afterEach(() => {
  cleanup();
  setSessionToken('');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Bots', () => {
  it('renders instance rows and summary stats from GET /api/bots', async () => {
    setup({
      'GET /api/bots': {
        bots: [
          { ...botFixture({ id: 'moho', name: 'MohoBot' }), plugins: [{ id: 'demo', state: 'ready', errors: 0 }] },
          botFixture({
            id: 'second',
            name: 'Second',
            running: false,
            sessions: 1,
            gateway: { connected: false, ping: -1, reconnects: 2 },
          }),
        ],
      },
    });

    renderWithProviders(<Bots permissions={['gateway.read']} />);

    expect(await screen.findByText('MohoBot')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
    expect(screen.getByText('2 个实例 · 1 个运行中 · 1 个网关在线')).toBeInTheDocument();
    expect(screen.getAllByText('1/2').length).toBe(2);
    expect(screen.getByText('42 ms')).toBeInTheDocument();
  });

  it('shows the empty state when no instances are registered', async () => {
    setup({ 'GET /api/bots': { bots: [] } });

    renderWithProviders(<Bots permissions={[]} />);

    expect(await screen.findByText('没有运行实例')).toBeInTheDocument();
  });

  it('shows an error state when GET /api/bots returns 500', async () => {
    setup({ 'GET /api/bots': () => jsonResponse({ error: 'boom' }, 500) });

    renderWithProviders(<Bots permissions={[]} />);

    expect(await screen.findByText('boom')).toBeInTheDocument();
  });

  it('loads gateway detail when a row is expanded', async () => {
    setup({
      'GET /api/bots': { bots: [botFixture({ id: 'moho', name: 'MohoBot' })] },
      'GET /api/bots/moho/gateway': {
        gateway: { connected: true, ping: 30, reconnects: 1, username: 'Moho#0001', guilds: 4 },
      },
    });

    renderWithProviders(<Bots permissions={['gateway.read']} />);
    expect(await screen.findByText('MohoBot')).toBeInTheDocument();

    screen.getByRole('button', { name: /详情/ }).click();

    expect(await screen.findByText('Moho#0001')).toBeInTheDocument();
    expect(screen.getByText('网关账号')).toBeInTheDocument();
  });

  it('restarts an instance through the confirmation nonce flow', async () => {
    const fetchMock = mockFetch({
      'GET /api/bots': { bots: [botFixture({ id: 'moho', name: 'MohoBot' })] },
      'POST /api/confirmations': { confirmation: { nonce: 'nonce-1' } },
      'POST /api/bots/moho/restart': { bot: { id: 'moho', running: true } },
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(window, 'prompt').mockReturnValue('确认');
    setSessionToken('test-token');

    renderWithProviders(<Bots permissions={['gateway.read', 'runtime.restart']} />);
    expect(await screen.findByText('MohoBot')).toBeInTheDocument();

    screen.getByRole('button', { name: /重启/ }).click();

    await waitFor(() => {
      const calls = fetchMock.mock.calls.map(([input, init]) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        return `${(init?.method ?? 'GET').toUpperCase()} ${new URL(url, 'http://localhost').pathname}`;
      });
      expect(calls).toContain('POST /api/bots/moho/restart');
    });

    const restartCall = fetchMock.mock.calls.find(([input, init]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      return new URL(url, 'http://localhost').pathname === '/api/bots/moho/restart'
        && (init?.method ?? 'GET').toUpperCase() === 'POST';
    });
    expect(restartCall).toBeDefined();
    const headers = new Headers(restartCall?.[1]?.headers);
    expect(headers.get('X-Admin-Confirmation')).toBe('nonce-1');
    expect(window.prompt).toHaveBeenCalled();
  });

  it('hides the restart control without runtime.restart permission', async () => {
    setup({ 'GET /api/bots': { bots: [botFixture({ id: 'moho', name: 'MohoBot' })] } });

    renderWithProviders(<Bots permissions={['gateway.read']} />);
    expect(await screen.findByText('MohoBot')).toBeInTheDocument();

    expect(screen.queryByRole('button', { name: /重启/ })).toBeNull();
    expect(screen.getByText('只读')).toBeInTheDocument();
  });
});
