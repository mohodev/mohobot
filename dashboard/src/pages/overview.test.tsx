import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../test/render';
import { mockFetch, botFixture, jsonResponse } from '../test/fixtures';
import { setSessionToken } from '../lib/api';
import { Overview } from './overview';

function setup(routes: Parameters<typeof mockFetch>[0]) {
  vi.stubGlobal('fetch', mockFetch(routes));
  setSessionToken('test-token');
}

beforeEach(() => {
  setSessionToken('test-token');
});

afterEach(() => {
  setSessionToken('');
  vi.unstubAllGlobals();
});

describe('Overview', () => {
  it('renders bot rows and summary stats from the runtime snapshot', async () => {
    setup({
      'GET /api/status': { now: new Date().toISOString(), bots: [botFixture(), botFixture({ id: 'second', name: 'Second', running: false, gateway: { connected: false, ping: -1, reconnects: 2 }, sessions: 1 })] },
      'GET /api/admin/health': { health: { runtime: 'up', bots: 2 } },
      'GET /api/metrics': { metrics: { requests: 120, errors: 2 } },
    });

    renderWithProviders(<Overview permissions={['status.read']} />);

    expect(await screen.findByText('MohoBot')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('120').length).toBeGreaterThan(0));
    expect(screen.getAllByText('1/2').length).toBeGreaterThan(0);
  });

  it('shows the empty state when no bots are registered', async () => {
    setup({
      'GET /api/status': { now: new Date().toISOString(), bots: [] },
      'GET /api/admin/health': { health: { runtime: 'idle', bots: 0 } },
      'GET /api/metrics': { metrics: {} },
    });

    renderWithProviders(<Overview permissions={[]} />);

    expect(await screen.findByText('没有运行实例')).toBeInTheDocument();
  });

  it('degrades gracefully when the status endpoint fails but health succeeds', async () => {
    setup({
      'GET /api/status': () => jsonResponse({ error: 'boom' }, 500),
      'GET /api/admin/health': { health: { runtime: 'up', bots: 0 } },
      'GET /api/metrics': { metrics: {} },
    });

    renderWithProviders(<Overview permissions={[]} />);

    expect(await screen.findByText(/部分数据源不可用/)).toBeInTheDocument();
    expect(screen.getAllByText('运行健康').length).toBeGreaterThan(0);
  });
});
