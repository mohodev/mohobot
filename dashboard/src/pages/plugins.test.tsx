import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../test/render';
import { mockFetch, botFixture, jsonResponse } from '../test/fixtures';
import { setSessionToken } from '../lib/api';
import { Plugins } from './plugins';

function setup(routes: Parameters<typeof mockFetch>[0], promptText = '确认') {
  const fetchMock = mockFetch(routes);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('prompt', vi.fn(() => promptText));
  setSessionToken('test-token');
  return fetchMock;
}

beforeEach(() => {
  setSessionToken('test-token');
});

afterEach(() => {
  setSessionToken('');
  vi.unstubAllGlobals();
});

describe('Plugins', () => {
  it('groups plugins by bot and counts states from the API', async () => {
    setup({
      'GET /api/bots': { bots: [
        botFixture({ id: 'moho', name: 'MohoBot' }),
        botFixture({ id: 'second', name: 'Second', running: false, adapter: 'qq' }),
      ] },
      'GET /api/bots/moho/plugins': { plugins: [
        { id: 'devtools', state: 'loaded', errors: 0 },
        { id: 'operator', state: 'failed', errors: 3 },
      ] },
      'GET /api/bots/second/plugins': { plugins: [{ id: 'ping', state: 'loaded', errors: 0 }] },
    });

    renderWithProviders(<Plugins permissions={['plugin.reload']} />);

    expect(await screen.findByText('devtools')).toBeInTheDocument();
    expect(screen.getByText('operator')).toBeInTheDocument();
    expect(screen.getByText('ping')).toBeInTheDocument();
    // Both bot groups render their headers/descriptions.
    expect(screen.getByText(/实例 moho/)).toBeInTheDocument();
    expect(screen.getByText(/实例 second/)).toBeInTheDocument();
    // Derived totals: 3 plugins, 1 failing (state "failed").
    expect(screen.getByText('异常插件').closest('.stat-card')).toHaveTextContent('1');
    expect(screen.getByText('插件总数').closest('.stat-card')).toHaveTextContent('3');
  });

  it('shows the empty state when no bots are registered', async () => {
    setup({ 'GET /api/bots': { bots: [] } });

    renderWithProviders(<Plugins permissions={[]} />);

    expect(await screen.findByText('没有运行实例')).toBeInTheDocument();
  });

  it('shows an error state when the bots endpoint fails', async () => {
    setup({ 'GET /api/bots': () => jsonResponse({ error: 'boom' }, 500) });

    renderWithProviders(<Plugins permissions={[]} />);

    expect(await screen.findByText(/boom/)).toBeInTheDocument();
  });

  it('keeps rendering other bots when one plugin listing fails', async () => {
    setup({
      'GET /api/bots': { bots: [
        botFixture({ id: 'moho', name: 'MohoBot' }),
        botFixture({ id: 'second', name: 'Second' }),
      ] },
      'GET /api/bots/moho/plugins': { plugins: [{ id: 'devtools', state: 'loaded', errors: 0 }] },
      'GET /api/bots/second/plugins': () => jsonResponse({ error: 'plugins unavailable' }, 503),
    });

    renderWithProviders(<Plugins permissions={['plugin.reload']} />);

    expect(await screen.findByText('devtools')).toBeInTheDocument();
    expect(screen.getByText(/读取该实例插件失败/)).toBeInTheDocument();
    expect(screen.getByText(/plugins unavailable/)).toBeInTheDocument();
    // The failing bot still renders its own panel header.
    expect(screen.getByText(/实例 second/)).toBeInTheDocument();
  });

  it('runs the confirmation nonce flow and posts the reload to the right path', async () => {
    const fetchMock = setup({
      'GET /api/bots': { bots: [botFixture({ id: 'moho', name: 'MohoBot', running: true })] },
      'GET /api/bots/moho/plugins': { plugins: [{ id: 'devtools', state: 'loaded', errors: 0 }] },
      'POST /api/confirmations': { confirmation: { nonce: 'nonce-1' } },
      'POST /api/bots/moho/plugins/devtools/reload': { plugin: { id: 'devtools', state: 'loaded', errors: 0 } },
    });

    renderWithProviders(<Plugins permissions={['plugin.reload']} />);

    const reload = await screen.findByRole('button', { name: /重载/ });
    expect(reload).toBeEnabled();
    reload.click();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/confirmations',
      expect.objectContaining({ method: 'POST' }),
    ));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/bots/moho/plugins/devtools/reload',
      expect.objectContaining({ method: 'POST' }),
    ));
    expect(window.prompt).toHaveBeenCalled();
  });

  it('disables the reload button without the plugin.reload permission', async () => {
    setup({
      'GET /api/bots': { bots: [botFixture({ id: 'moho', name: 'MohoBot', running: true })] },
      'GET /api/bots/moho/plugins': { plugins: [{ id: 'devtools', state: 'loaded', errors: 0 }] },
    });

    renderWithProviders(<Plugins permissions={[]} />);

    const reload = await screen.findByRole('button', { name: /重载/ });
    expect(reload).toBeDisabled();
  });
});
