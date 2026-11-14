import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../test/render';
import { mockFetch, jsonResponse } from '../test/fixtures';
import { setSessionToken } from '../lib/api';
import { Jargon } from './jargon';

type Routes = Parameters<typeof mockFetch>[0];

function setup(routes: Routes) {
  const fetchMock = mockFetch(routes);
  vi.stubGlobal('fetch', fetchMock);
  setSessionToken('test-token');
  return fetchMock;
}

function writeCalls(fetchMock: ReturnType<typeof mockFetch>, path: string) {
  return fetchMock.mock.calls.filter(([input, init]) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    return method === 'POST' && new URL(raw, 'http://localhost').pathname === path;
  });
}

function parsedBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== 'string') return {};
  return JSON.parse(init.body) as Record<string, unknown>;
}

const jargonEntry = {
  id: 'abc123',
  term: '摆烂',
  meaning: '放任不管',
  examples: ['今天摆烂吧'],
  sourceAuthors: ['user-1'],
  sharingGroup: { channelId: 'chan-1', guildId: 'guild-1' },
  status: 'candidate',
  confidence: 0.5,
  firstSeen: Date.now() - 3600_000,
  lastSeen: Date.now() - 120_000,
  usageCount: 4,
};

const pendingRecord = {
  kind: 'expression-memory',
  recordVersion: 2 as const,
  id: 'rec-1',
  botId: 'moho',
  userId: 'user-1',
  channelId: 'chan-1',
  category: 'preference' as const,
  text: '用户偏好简短回答',
  normalized: '用户偏好简短回答',
  status: 'pending',
  confidence: 0.9,
  createdAt: Date.now() - 7200_000,
  updatedAt: Date.now() - 60_000,
};

beforeEach(() => {
  setSessionToken('test-token');
  vi.stubGlobal('prompt', vi.fn(() => '确认'));
});

afterEach(() => {
  setSessionToken('');
  vi.unstubAllGlobals();
});

describe('Jargon — 群体黑话', () => {
  it('renders jargon rows from a successful GET', async () => {
    setup({
      'GET /api/memory/jargon': { entries: [jargonEntry] },
    });

    renderWithProviders(<Jargon permissions={['memory.read']} />);

    expect(await screen.findByText('摆烂')).toBeInTheDocument();
    expect(screen.getByText('放任不管')).toBeInTheDocument();
    // "候选" also appears as a filter option, so allow multiple matches.
    expect(screen.getAllByText('候选').length).toBeGreaterThan(0);
    expect(screen.getByText('chan-1')).toBeInTheDocument();
  });

  it('shows the empty state when there are no jargon entries', async () => {
    setup({ 'GET /api/memory/jargon': { entries: [] } });

    renderWithProviders(<Jargon permissions={['memory.read']} />);

    expect(await screen.findByText('暂无黑话条目')).toBeInTheDocument();
  });

  it('shows an error state when the jargon GET returns 500', async () => {
    setup({
      'GET /api/memory/jargon': () => jsonResponse({ error: '黑话服务不可用' }, 500),
    });

    renderWithProviders(<Jargon permissions={['memory.read']} />);

    expect(await screen.findByText('黑话服务不可用')).toBeInTheDocument();
  });

  it('hides review actions and warns about read-only mode without memory.write', async () => {
    setup({ 'GET /api/memory/jargon': { entries: [jargonEntry] } });

    renderWithProviders(<Jargon permissions={['memory.read']} />);

    expect(await screen.findByText('摆烂')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /批准/ })).toBeNull();
    expect(screen.getAllByText(/只读模式/).length).toBeGreaterThan(0);
  });
});

describe('Jargon — 表达记忆', () => {
  async function openExpressionTab(fetchMock: ReturnType<typeof mockFetch>) {
    renderWithProviders(<Jargon permissions={['memory.read', 'memory.write', 'memory.delete']} />);
    fireEvent.click(await screen.findByRole('tab', { name: '表达记忆' }));
    const input = await screen.findByLabelText('Bot ID');
    fireEvent.change(input, { target: { value: 'moho' } });
    return fetchMock;
  }

  it('runs the confirmation nonce flow on approve', async () => {
    const fetchMock = setup({
      'GET /api/memory/jargon': { entries: [] },
      'GET /api/memory/expressions': { records: [pendingRecord] },
      'GET /api/memory/expressions/recycle-bin': { records: [] },
      'POST /api/confirmations': { confirmation: { nonce: 'nonce-1' } },
      'POST /api/memory/expressions/approve': { outcome: 'applied' },
    });

    await openExpressionTab(fetchMock);

    expect(await screen.findByText('用户偏好简短回答')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /批准/ }));

    await waitFor(() => expect(writeCalls(fetchMock, '/api/memory/expressions/approve')).toHaveLength(1));
    expect(window.prompt).toHaveBeenCalled();
    expect(writeCalls(fetchMock, '/api/confirmations')).toHaveLength(1);
    const approveCall = writeCalls(fetchMock, '/api/memory/expressions/approve')[0];
    expect(parsedBody(approveCall?.[1])).toEqual({ botId: 'moho', userId: 'user-1', id: 'rec-1' });
  });

  it('shows the empty state when the bot has no expression records', async () => {
    const fetchMock = setup({
      'GET /api/memory/jargon': { entries: [] },
      'GET /api/memory/expressions': { records: [] },
      'GET /api/memory/expressions/recycle-bin': { records: [] },
    });

    await openExpressionTab(fetchMock);

    expect(await screen.findByText('暂无表达记忆')).toBeInTheDocument();
    expect(await screen.findByText('回收站为空')).toBeInTheDocument();
  });

  it('surfaces a 500 error from the expression list', async () => {
    const fetchMock = setup({
      'GET /api/memory/jargon': { entries: [] },
      'GET /api/memory/expressions': () => jsonResponse({ error: '表达记忆读取失败' }, 500),
      'GET /api/memory/expressions/recycle-bin': { records: [] },
    });

    await openExpressionTab(fetchMock);

    expect(await screen.findByText('表达记忆读取失败')).toBeInTheDocument();
  });

  it('restores a record from the recycle bin', async () => {
    const fetchMock = setup({
      'GET /api/memory/jargon': { entries: [] },
      'GET /api/memory/expressions': { records: [] },
      'GET /api/memory/expressions/recycle-bin': {
        records: [{ ...pendingRecord, id: 'bin-1', status: 'approved', tombstone: { at: Date.now() - 1000 } }],
      },
      'POST /api/confirmations': { confirmation: { nonce: 'nonce-2' } },
      'POST /api/memory/expressions/restore': { outcome: 'applied' },
    });

    await openExpressionTab(fetchMock);

    fireEvent.click(await screen.findByRole('button', { name: /恢复/ }));

    await waitFor(() => expect(writeCalls(fetchMock, '/api/memory/expressions/restore')).toHaveLength(1));
    const restoreCall = writeCalls(fetchMock, '/api/memory/expressions/restore')[0];
    expect(parsedBody(restoreCall?.[1])).toEqual({ botId: 'moho', userId: 'user-1', id: 'bin-1' });
  });
});
