import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithProviders } from '../test/render';
import { mockFetch, jsonResponse } from '../test/fixtures';
import { setSessionToken } from '../lib/api';
import { Providers } from './providers';

function setup(routes: Parameters<typeof mockFetch>[0]) {
  const fetchMock = mockFetch(routes);
  vi.stubGlobal('fetch', fetchMock);
  setSessionToken('test-token');
  return fetchMock;
}

const MAIN: Record<string, unknown> = {
  botId: 'main',
  provider: 'openai',
  model: 'gpt-4o-mini',
  baseUrlConfigured: true,
  apiKeyConfigured: true,
  taskRoutes: { reply: 'gpt-4o-mini', summarize: 'gpt-4o' },
};

const SECOND: Record<string, unknown> = {
  botId: 'second',
  provider: 'anthropic',
  model: 'claude-sonnet',
  baseUrlConfigured: false,
  apiKeyConfigured: false,
  taskRoutes: {},
};

/** Looks up the table row whose first cell is the given bot id. */
function rowFor(botId: string): HTMLElement {
  const cell = screen.getByText(botId);
  const row = cell.closest('tr');
  if (!row) throw new Error(`no row for ${botId}`);
  return row;
}

beforeEach(() => {
  setSessionToken('test-token');
});

afterEach(() => {
  cleanup();
  setSessionToken('');
  vi.unstubAllGlobals();
});

describe('Providers', () => {
  it('renders provider rows and probe pill from mocked responses', async () => {
    setup({
      'GET /api/providers': { providers: [MAIN, SECOND] },
      'POST /api/providers/main/probe': { probe: { botId: 'main', ok: true, checkedAt: 1700000000000 } },
    });

    renderWithProviders(<Providers permissions={['providers.read', 'providers.probe']} />);

    const main = await screen.findByText('main');
    expect(main).toBeInTheDocument();
    const mainRow = rowFor('main');
    expect(within(mainRow).getByText('openai')).toBeInTheDocument();
    expect(within(mainRow).getAllByText('gpt-4o-mini').length).toBeGreaterThan(0);
    // both the key and base URL columns are configured for this bot
    expect(within(mainRow).getAllByText('已配置').length).toBe(2);
    expect(within(mainRow).getByText('2 条路由')).toBeInTheDocument();

    const secondRow = rowFor('second');
    expect(within(secondRow).getByText('anthropic')).toBeInTheDocument();
    expect(within(secondRow).getByText('未配置')).toBeInTheDocument();
    expect(within(secondRow).getByText('使用默认')).toBeInTheDocument();
    expect(within(secondRow).getByText('无')).toBeInTheDocument();

    fireEvent.click(within(mainRow).getByRole('button', { name: /探测/ }));

    expect(await screen.findByText('正常')).toBeInTheDocument();
    expect(screen.getByText(/最近检测/)).toBeInTheDocument();
  });

  it('shows the empty state when the API returns an empty list', async () => {
    setup({ 'GET /api/providers': { providers: [] } });

    renderWithProviders(<Providers permissions={['providers.read']} />);

    expect(await screen.findByText('没有可展示的供应商')).toBeInTheDocument();
  });

  it('shows an error state when the GET returns 500', async () => {
    setup({ 'GET /api/providers': () => jsonResponse({ error: 'boom' }, 500) });

    renderWithProviders(<Providers permissions={['providers.read']} />);

    expect(await screen.findByText('boom')).toBeInTheDocument();
  });

  it('probe action POSTs to the bot probe endpoint', async () => {
    const fetchMock = setup({
      'GET /api/providers': { providers: [MAIN] },
      'POST /api/providers/main/probe': { probe: { botId: 'main', ok: false, detail: 'API key not configured', checkedAt: 1700000000000 } },
    });

    renderWithProviders(<Providers permissions={['providers.read', 'providers.probe']} />);

    await screen.findByText('main');
    const mainRow = rowFor('main');
    fireEvent.click(within(mainRow).getByRole('button', { name: /探测/ }));

    expect(await screen.findByText('失败')).toBeInTheDocument();
    expect(screen.getByText('API key not configured')).toBeInTheDocument();

    await waitFor(() => {
      const calls = fetchMock.mock.calls.map((call) => {
        const input = call[0];
        const init = call[1];
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        return `${(init?.method ?? 'GET').toUpperCase()} ${url}`;
      });
      expect(calls).toContain('POST /api/providers/main/probe');
    });
  });

  it('hides the probe control without the providers.probe permission', async () => {
    setup({ 'GET /api/providers': { providers: [MAIN] } });

    renderWithProviders(<Providers permissions={['providers.read']} />);

    expect(await screen.findByText('main')).toBeInTheDocument();
    expect(screen.getByText(/只读（缺少 providers.probe）/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /探测/ })).not.toBeInTheDocument();
  });
});
