import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '../test/render';
import { renderWithProviders } from '../test/render';
import { jsonResponse, mockFetch } from '../test/fixtures';
import { setSessionToken } from '../lib/api';
import { Logs } from './logs';

function setup(routes: Parameters<typeof mockFetch>[0]) {
  vi.stubGlobal('fetch', mockFetch(routes));
  setSessionToken('test-token');
}

const INFO_ROW = { seq: 1, time: 1_700_000_000_000, level: 'info', component: 'runtime', message: 'pipeline started' };
const WARN_ROW = { seq: 2, time: 1_700_000_001_000, level: 'warn', component: 'discord', message: 'gateway slow' };
const ERROR_ROW = { seq: 3, time: 1_700_000_002_000, level: 'error', component: 'runtime', message: 'unhandled failure' };

beforeEach(() => {
  setSessionToken('test-token');
  // 级别筛选保存在 URL hash 中，测试之间需要重置。
  window.location.hash = '';
});

afterEach(() => {
  setSessionToken('');
  vi.unstubAllGlobals();
});

describe('Logs', () => {
  it('renders log rows with level pills and window stats from a successful GET', async () => {
    setup({
      'GET /api/logs': {
        logs: { items: [INFO_ROW, WARN_ROW, ERROR_ROW], oldestSeq: 1, latestSeq: 3, nextSeq: 3, gap: false },
      },
    });

    renderWithProviders(<Logs permissions={['logs.read']} />);

    expect(await screen.findByText('pipeline started')).toBeInTheDocument();
    expect(screen.getByText('gateway slow')).toBeInTheDocument();
    expect(screen.getByText('unhandled failure')).toBeInTheDocument();
    expect(screen.getAllByText('runtime').length).toBe(2);
    expect(screen.getByText('discord')).toBeInTheDocument();
    expect(screen.getAllByText('error').length).toBeGreaterThan(0);
    expect(screen.getAllByText('warn').length).toBeGreaterThan(0);
    expect(screen.getByText(/显示 3 \/ 3 条/)).toBeInTheDocument();
  });

  it('accepts a bare { items } envelope as well as { logs: { items } }', async () => {
    setup({ 'GET /api/logs': { items: [INFO_ROW] } });

    renderWithProviders(<Logs permissions={['logs.read']} />);

    expect(await screen.findByText('pipeline started')).toBeInTheDocument();
  });

  it('narrows rows with the debounced search across level, component and message', async () => {
    setup({ 'GET /api/logs': { logs: { items: [INFO_ROW, WARN_ROW, ERROR_ROW] } } });

    renderWithProviders(<Logs permissions={['logs.read']} />);
    expect(await screen.findByText('pipeline started')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('搜索日志'), { target: { value: 'discord' } });

    await waitFor(() => expect(screen.queryByText('pipeline started')).not.toBeInTheDocument());
    expect(screen.getByText('gateway slow')).toBeInTheDocument();
    expect(screen.queryByText('unhandled failure')).not.toBeInTheDocument();
    expect(screen.getByText(/显示 1 \/ 3 条/)).toBeInTheDocument();
  });

  it('narrows rows with the level filter tab', async () => {
    setup({ 'GET /api/logs': { logs: { items: [INFO_ROW, WARN_ROW, ERROR_ROW] } } });

    renderWithProviders(<Logs permissions={['logs.read']} />);
    expect(await screen.findByText('pipeline started')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /^error/ }));

    await waitFor(() => expect(screen.queryByText('pipeline started')).not.toBeInTheDocument());
    expect(screen.getByText('unhandled failure')).toBeInTheDocument();
    expect(screen.queryByText('gateway slow')).not.toBeInTheDocument();
  });

  it('shows the empty state when the API returns no rows', async () => {
    setup({ 'GET /api/logs': { logs: { items: [] } } });

    renderWithProviders(<Logs permissions={[]} />);

    expect(await screen.findByText('暂无日志')).toBeInTheDocument();
  });

  it('shows an error state when the GET fails with 500', async () => {
    setup({ 'GET /api/logs': () => jsonResponse({ error: '日志缓冲区不可用' }, 500) });

    renderWithProviders(<Logs permissions={['logs.read']} />);

    expect(await screen.findByText('日志缓冲区不可用')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
  });

  it('disables the NDJSON export button while there is nothing to export', async () => {
    setup({ 'GET /api/logs': { logs: { items: [] } } });

    renderWithProviders(<Logs permissions={[]} />);

    const button = await screen.findByRole('button', { name: /导出 NDJSON/ });
    expect(button).toHaveAttribute('disabled');
  });

  it('enables the NDJSON export button once rows are loaded without triggering a download', async () => {
    const createObjectURL = vi.fn(() => 'blob:mock');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    setup({ 'GET /api/logs': { logs: { items: [INFO_ROW] } } });

    renderWithProviders(<Logs permissions={['logs.read']} />);
    expect(await screen.findByText('pipeline started')).toBeInTheDocument();

    const button = screen.getByRole('button', { name: /导出 NDJSON/ });
    expect(button).not.toHaveAttribute('disabled');
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('shows the live indicator once the real-time tail switch is enabled', async () => {
    setup({ 'GET /api/logs': { logs: { items: [INFO_ROW] } } });

    renderWithProviders(<Logs permissions={['logs.read']} />);
    expect(await screen.findByText('pipeline started')).toBeInTheDocument();
    expect(screen.queryByText('实时')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox'));

    expect(await screen.findByText('实时')).toBeInTheDocument();
  });

  it('requests only the newest window with a bounded limit', async () => {
    const fetchMock = mockFetch({ 'GET /api/logs': { logs: { items: [INFO_ROW] } } });
    vi.stubGlobal('fetch', fetchMock);
    setSessionToken('test-token');

    renderWithProviders(<Logs permissions={['logs.read']} />);
    await screen.findByText('pipeline started');

    const first = fetchMock.mock.calls[0];
    const url = new URL(String(first?.[0]), 'http://localhost');
    expect(url.pathname).toBe('/api/logs');
    expect(url.searchParams.get('limit')).toBe('500');
    expect(url.searchParams.get('after')).toBeNull();
  });
});
