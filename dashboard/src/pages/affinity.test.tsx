import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../test/render';
import { jsonResponse, mockFetch } from '../test/fixtures';
import { setSessionToken } from '../lib/api';
import type { AffinityRecord } from '../lib/types';
import { Affinity } from './affinity';

function affinityFixture(overrides: Partial<AffinityRecord> = {}): AffinityRecord {
  return {
    botId: 'moho',
    userId: 'user-1',
    score: 12.5,
    interactions: 7,
    lastReason: 'helpful',
    updatedAt: new Date(Date.now() - 120_000).toISOString(),
    notes: ['第一次互动'],
    ...overrides,
  };
}

function setup(routes: Parameters<typeof mockFetch>[0]) {
  const fetchMock = mockFetch(routes);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('prompt', vi.fn(() => '确认'));
  setSessionToken('test-token');
  return fetchMock;
}

beforeEach(() => {
  setSessionToken('test-token');
});

afterEach(() => {
  cleanup();
  setSessionToken('');
  vi.unstubAllGlobals();
});

describe('Affinity', () => {
  it('renders rows from a mocked successful GET', async () => {
    setup({
      'GET /api/affinity': {
        affinity: [
          affinityFixture(),
          affinityFixture({ userId: 'user-2', score: -3, interactions: 2, lastReason: 'conflict', notes: [] }),
        ],
      },
    });

    renderWithProviders(<Affinity permissions={['memory.read']} />);

    expect(await screen.findByText('user-1')).toBeInTheDocument();
    expect(screen.getByText('user-2')).toBeInTheDocument();
    // score, interactions, and the mirrored reason label come from the response
    expect(screen.getByText('12.5')).toBeInTheDocument();
    expect(screen.getAllByText('有帮助').length).toBeGreaterThan(0);
    expect(screen.getAllByText('冲突').length).toBeGreaterThan(0);
    expect(screen.getByText('第一次互动')).toBeInTheDocument();
    expect(screen.getByText('共 2 条记录 · 当前显示 2 条')).toBeInTheDocument();
  });

  it('sorts rows by score descending and filters by userId', async () => {
    setup({
      'GET /api/affinity': {
        affinity: [
          affinityFixture({ userId: 'low', score: 1 }),
          affinityFixture({ userId: 'high', score: 90 }),
        ],
      },
    });

    renderWithProviders(<Affinity permissions={['memory.read']} />);

    await screen.findByText('low');
    const rows = screen.getAllByRole('row').slice(1); // drop the header row
    expect(rows[0]).toHaveTextContent('high');
    expect(rows[1]).toHaveTextContent('low');

    fireEvent.change(screen.getByLabelText('按用户 ID 搜索'), { target: { value: 'high' } });
    await waitFor(() => expect(screen.queryByText('low')).not.toBeInTheDocument());
    expect(screen.getByText('high')).toBeInTheDocument();
  });

  it('shows the empty state when the API returns an empty list', async () => {
    setup({ 'GET /api/affinity': { affinity: [] } });

    renderWithProviders(<Affinity permissions={['memory.read']} />);

    expect(await screen.findByText('暂无好感度记录')).toBeInTheDocument();
  });

  it('shows an error state when the GET returns 500', async () => {
    setup({ 'GET /api/affinity': () => jsonResponse({ error: 'affinity store offline' }, 500) });

    renderWithProviders(<Affinity permissions={['memory.read']} />);

    expect(await screen.findByText('affinity store offline')).toBeInTheDocument();
  });

  it('gates the adjust control on memory.write', async () => {
    setup({ 'GET /api/affinity': { affinity: [affinityFixture()] } });

    renderWithProviders(<Affinity permissions={['memory.read']} />);

    expect(await screen.findByText('user-1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '调整 user-1 的好感度' })).not.toBeInTheDocument();
    expect(screen.getByText(/缺少 memory.write 权限/)).toBeInTheDocument();
    expect(screen.getAllByText('只读').length).toBeGreaterThan(0);
  });

  it('runs the confirmation flow and POSTs the right body to /api/affinity/adjust', async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchMock = setup({
      'GET /api/affinity': { affinity: [affinityFixture()] },
      'POST /api/confirmations': { confirmation: { nonce: 'nonce-123' } },
      'POST /api/affinity/adjust': (init?: RequestInit) => {
        captured = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return jsonResponse({ affinity: affinityFixture({ score: 15.5 }) });
      },
    });

    renderWithProviders(<Affinity permissions={['memory.read', 'memory.write']} />);

    fireEvent.click(await screen.findByRole('button', { name: '调整 user-1 的好感度' }));

    // The modal is prefilled from the selected row.
    const userId = await screen.findByDisplayValue('user-1');
    expect(userId).toBeInTheDocument();
    expect(screen.getByDisplayValue('moho')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('例如 2 或 -1.5'), { target: { value: '3' } });
    fireEvent.change(screen.getByPlaceholderText('可选备注，最多 500 字'), { target: { value: '一起聊了游戏' } });

    fireEvent.click(screen.getByRole('button', { name: '提交调整' }));

    await waitFor(() => expect(captured).toBeDefined());
    expect(captured).toEqual({
      botId: 'moho',
      userId: 'user-1',
      delta: 3,
      note: '一起聊了游戏',
    });
    // The server decides the reason; the request must not carry one.
    expect(captured).not.toHaveProperty('reason');

    // The confirmation nonce flow ran before the write.
    const calls = fetchMock.mock.calls.map((call) => `${String((call[1] as RequestInit | undefined)?.method ?? 'GET')} ${String(call[0])}`);
    expect(calls).toContain('POST /api/confirmations');
    expect(calls).toContain('POST /api/affinity/adjust');

    expect(await screen.findByText('好感度已调整。')).toBeInTheDocument();
  });

  it('rejects a non-numeric delta before calling the API', async () => {
    const fetchMock = setup({
      'GET /api/affinity': { affinity: [affinityFixture()] },
      'POST /api/confirmations': { confirmation: { nonce: 'nonce-123' } },
      'POST /api/affinity/adjust': { affinity: affinityFixture() },
    });

    renderWithProviders(<Affinity permissions={['memory.write']} />);

    fireEvent.click(await screen.findByRole('button', { name: '调整 user-1 的好感度' }));
    fireEvent.change(await screen.findByPlaceholderText('例如 2 或 -1.5'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: '提交调整' }));

    expect(await screen.findByText('delta 必须是数字。')).toBeInTheDocument();
    const adjustCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes('/api/affinity/adjust'));
    expect(adjustCalls).toHaveLength(0);
  });
});
