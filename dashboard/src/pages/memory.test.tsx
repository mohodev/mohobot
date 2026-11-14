import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../test/render';
import { mockFetch, jsonResponse } from '../test/fixtures';
import { setSessionToken } from '../lib/api';
import { Memory, buildMemoryQuery } from './memory';

const KEY = 'semantic-memory:main:u-1:100:id-1';
const ENCODED_KEY = encodeURIComponent(KEY);

function memoryFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'id-1',
    key: KEY,
    botId: 'main',
    userId: 'u-1',
    channelId: 'chan-1',
    scope: 'private',
    kind: 'fact',
    textLength: 42,
    textHash: 'abcdef0123456789',
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

const ALL_PERMISSIONS = ['memory.metadata.read', 'memory.read', 'memory.write', 'memory.delete'];

function setup(routes: Parameters<typeof mockFetch>[0]) {
  const fetchMock = mockFetch(routes);
  vi.stubGlobal('fetch', fetchMock);
  setSessionToken('test-token');
  return fetchMock;
}

function calledUrls(fetchMock: ReturnType<typeof mockFetch>, method: string): string[] {
  return fetchMock.mock.calls
    .filter((call) => ((call[1]?.method ?? 'GET') as string).toUpperCase() === method)
    .map((call) => String(call[0]));
}

beforeEach(() => {
  setSessionToken('test-token');
});

afterEach(() => {
  setSessionToken('');
  vi.unstubAllGlobals();
});

describe('buildMemoryQuery', () => {
  it('builds the documented filter query string in a stable order', () => {
    expect(buildMemoryQuery({ scope: 'shared', botId: 'main', userId: 'u-1', limit: 50 }))
      .toBe('?scope=shared&botId=main&userId=u-1&limit=50');
  });

  it('omits blank filters and always sends the limit', () => {
    expect(buildMemoryQuery({ scope: '', botId: '  ', userId: '', limit: 100 })).toBe('?limit=100');
  });
});

describe('Memory', () => {
  it('renders memory rows returned by the list endpoint', async () => {
    setup({
      'GET /api/memory': { memories: [memoryFixture(), memoryFixture({ id: 'id-2', key: `${KEY}-2`, kind: 'preference', scope: 'shared', botId: 'second', channelId: 'chan-2' })] },
    });

    renderWithProviders(<Memory permissions={ALL_PERMISSIONS} />);

    expect(await screen.findByText('fact')).toBeInTheDocument();
    expect(screen.getByText('preference')).toBeInTheDocument();
    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.getByText('second')).toBeInTheDocument();
    expect(screen.getAllByText('私密').length).toBeGreaterThan(0);
    expect(screen.getAllByText('共享').length).toBeGreaterThan(0);
    expect(screen.getByText('当前返回 2 条记录（按 scope 与主体过滤后的元数据）。')).toBeInTheDocument();
  });

  it('shows the empty state when the API returns no memories', async () => {
    setup({ 'GET /api/memory': { memories: [] } });

    renderWithProviders(<Memory permissions={ALL_PERMISSIONS} />);

    expect(await screen.findByText('没有匹配的语义记忆')).toBeInTheDocument();
  });

  it('shows an error state when the list endpoint returns 500', async () => {
    setup({ 'GET /api/memory': () => jsonResponse({ error: 'memory store unavailable' }, 500) });

    renderWithProviders(<Memory permissions={ALL_PERMISSIONS} />);

    expect(await screen.findByText('memory store unavailable')).toBeInTheDocument();
  });

  it('runs the confirmation flow and calls DELETE when deleting a memory', async () => {
    const prompt = vi.fn(() => '确认');
    vi.stubGlobal('prompt', prompt);
    const fetchMock = setup({
      'GET /api/memory': { memories: [memoryFixture()] },
      'POST /api/confirmations': { confirmation: { nonce: 'nonce-1' } },
      [`DELETE /api/memory/${ENCODED_KEY}`]: { deleted: true },
    });

    renderWithProviders(<Memory permissions={ALL_PERMISSIONS} />);

    fireEvent.click(await screen.findByRole('button', { name: '删除' }));

    await waitFor(() => {
      expect(calledUrls(fetchMock, 'DELETE')).toContain(`/api/memory/${ENCODED_KEY}`);
    });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(calledUrls(fetchMock, 'POST').some((url) => url.endsWith('/api/confirmations'))).toBe(true);
    // The list is reloaded after a successful delete.
    await waitFor(() => {
      expect(calledUrls(fetchMock, 'GET').filter((url) => url.startsWith('/api/memory?')).length).toBeGreaterThan(1);
    });
  });

  it('does not call DELETE when the confirmation prompt is cancelled', async () => {
    vi.stubGlobal('prompt', vi.fn(() => '取消'));
    const fetchMock = setup({
      'GET /api/memory': { memories: [memoryFixture()] },
    });

    renderWithProviders(<Memory permissions={ALL_PERMISSIONS} />);

    fireEvent.click(await screen.findByRole('button', { name: '删除' }));

    await waitFor(() => {
      expect(calledUrls(fetchMock, 'POST').length).toBe(0);
    });
    expect(calledUrls(fetchMock, 'DELETE')).toHaveLength(0);
  });

  it('sends the filter values as a query string when the query button is used', async () => {
    const fetchMock = setup({ 'GET /api/memory': { memories: [] } });

    renderWithProviders(<Memory permissions={ALL_PERMISSIONS} />);
    await screen.findByText('没有匹配的语义记忆');

    fireEvent.change(screen.getByLabelText('范围筛选'), { target: { value: 'private' } });
    fireEvent.change(screen.getByLabelText('Bot 筛选'), { target: { value: 'main' } });
    fireEvent.change(screen.getByLabelText('用户筛选'), { target: { value: 'u-1' } });
    fireEvent.click(screen.getByRole('button', { name: /查询/ }));

    await waitFor(() => {
      expect(calledUrls(fetchMock, 'GET')).toContain('/api/memory?scope=private&botId=main&userId=u-1&limit=100');
    });
  });

  it('hides delete controls when the principal lacks memory.delete', async () => {
    setup({ 'GET /api/memory': { memories: [memoryFixture()] } });

    renderWithProviders(<Memory permissions={['memory.metadata.read', 'memory.read']} />);

    expect(await screen.findByText('fact')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '删除' })).toBeNull();
    expect(screen.getAllByText('只读').length).toBeGreaterThan(0);
  });

  it('loads the semantic recycle bin for the governance bot and restores through a confirmed write', async () => {
    const prompt = vi.fn(() => '确认');
    vi.stubGlobal('prompt', prompt);
    const fetchMock = setup({
      'GET /api/memory': { memories: [] },
      'GET /api/memory/semantic/recycle-bin': { records: [{ id: 'id-1', botId: 'main', userId: 'u-1', scope: 'shared', text: 't', createdAt: 10, tombstone: { at: 20, reason: 'admin request' } }] },
      'POST /api/confirmations': { confirmation: { nonce: 'nonce-2' } },
      'POST /api/memory/semantic/restore': { outcome: 'applied' },
    });

    renderWithProviders(<Memory permissions={ALL_PERMISSIONS} />);

    fireEvent.change(screen.getByLabelText('治理 Bot'), { target: { value: 'main' } });

    expect(await screen.findByText('admin request')).toBeInTheDocument();
    expect(calledUrls(fetchMock, 'GET')).toContain('/api/memory/semantic/recycle-bin?botId=main');

    fireEvent.click(screen.getByRole('button', { name: /恢复/ }));

    await waitFor(() => {
      expect(calledUrls(fetchMock, 'POST')).toContain('/api/memory/semantic/restore');
    });
    await waitFor(() => {
      expect(screen.getByText(/恢复请求已提交/)).toBeInTheDocument();
    });
  });

  it('reports dry-run import results without a confirmation prompt', async () => {
    const prompt = vi.fn(() => '确认');
    vi.stubGlobal('prompt', prompt);
    const fetchMock = setup({
      'GET /api/memory': { memories: [] },
      'POST /api/memory/semantic/import-dry-run': { result: { lines: 2, valid: 1, invalid: 1, records: [{ id: 'id-1', scope: 'shared', text: 't', createdAt: 10 }] } },
    });

    renderWithProviders(<Memory permissions={ALL_PERMISSIONS} />);
    await screen.findByText('没有匹配的语义记忆');

    fireEvent.click(screen.getByRole('tab', { name: '导入试运行' }));
    fireEvent.change(screen.getByLabelText(/JSONL 数据/), { target: { value: '{"id":"id-1"}' } });
    fireEvent.click(screen.getByRole('button', { name: /试运行校验/ }));

    await waitFor(() => {
      expect(calledUrls(fetchMock, 'POST')).toContain('/api/memory/semantic/import-dry-run');
    });
    expect(prompt).not.toHaveBeenCalled();
    expect(await screen.findByText('有效记录')).toBeInTheDocument();
    expect(screen.getByText('解析行数')).toBeInTheDocument();
  });
});
