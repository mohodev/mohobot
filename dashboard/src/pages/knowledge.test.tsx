import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/render';
import { jsonResponse, mockFetch } from '../test/fixtures';
import { setSessionToken } from '../lib/api';
import { Knowledge } from './knowledge';

type Routes = Parameters<typeof mockFetch>[0];

const NOW = Date.now();

const baseFixture = {
  kind: 'knowledge-base',
  recordVersion: 1,
  id: 'kb-one',
  name: '产品手册',
  description: '本地产品文档',
  documentCount: 3,
  createdAt: NOW - 86_400_000,
  updatedAt: NOW - 60_000,
};

const secondBaseFixture = {
  ...baseFixture,
  id: 'kb-two',
  name: '客服话术',
  description: '',
  documentCount: 0,
};

const documentFixture = {
  kind: 'knowledge-document',
  recordVersion: 1,
  id: 'doc-1',
  baseId: 'kb-one',
  name: '退换货政策',
  chunkCount: 2,
  textLength: 2048,
  createdAt: NOW - 3_600_000,
  updatedAt: NOW - 120_000,
};

const detailRoutes: Routes = {
  'GET /api/knowledge-bases/kb-one': { ok: true, base: baseFixture },
  'GET /api/knowledge-bases/kb-one/documents': { ok: true, documents: [documentFixture] },
  'GET /api/knowledge-bases/kb-one/bindings': {
    ok: true,
    bindings: [{ kind: 'knowledge-binding', recordVersion: 1, baseId: 'kb-one', targetType: 'bot', targetId: 'moho', createdAt: NOW - 900 }],
  },
};

function setup(routes: Routes) {
  const fetchMock = mockFetch(routes);
  vi.stubGlobal('fetch', fetchMock);
  setSessionToken('test-token');
  vi.spyOn(window, 'prompt').mockReturnValue('确认');
  return fetchMock;
}

function urlOf(input: unknown): string {
  return String(input);
}

beforeEach(() => {
  vi.spyOn(window, 'prompt').mockReturnValue('确认');
});

afterEach(() => {
  setSessionToken('');
  vi.unstubAllGlobals();
});

describe('Knowledge', () => {
  it('renders knowledge base rows from the list endpoint', async () => {
    setup({ 'GET /api/knowledge-bases': { ok: true, bases: [baseFixture, secondBaseFixture] } });

    renderWithProviders(<Knowledge permissions={['knowledge.read']} />);

    expect(await screen.findByText('产品手册')).toBeInTheDocument();
    expect(screen.getByText('客服话术')).toBeInTheDocument();
    expect(screen.getByText('kb-one')).toBeInTheDocument();
    expect(screen.getByText('2 个知识库')).toBeInTheDocument();
    // Read-only principals get no mutation entry points.
    expect(screen.queryByRole('button', { name: /新建知识库/ })).not.toBeInTheDocument();
    expect(screen.getByText('只读权限')).toBeInTheDocument();
  });

  it('shows the empty state when no bases exist', async () => {
    setup({ 'GET /api/knowledge-bases': { ok: true, bases: [] } });

    renderWithProviders(<Knowledge permissions={['knowledge.read', 'knowledge.write']} />);

    expect(await screen.findByText('还没有知识库')).toBeInTheDocument();
    expect(screen.getByText('未选择知识库')).toBeInTheDocument();
  });

  it('shows an error state when the list endpoint returns 500', async () => {
    setup({ 'GET /api/knowledge-bases': () => jsonResponse({ ok: false, error: '知识库服务不可用' }, 500) });

    renderWithProviders(<Knowledge permissions={['knowledge.read']} />);

    expect(await screen.findByText('知识库服务不可用')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /重试/ })).toBeInTheDocument();
  });

  it('creates a base through the confirmation nonce flow', async () => {
    const fetchMock = setup({
      'GET /api/knowledge-bases': { ok: true, bases: [] },
      'POST /api/confirmations': { ok: true, confirmation: { nonce: 'nonce-9' } },
      'POST /api/knowledge-bases': () => jsonResponse({ ok: true, base: baseFixture }, 201),
    });

    renderWithProviders(<Knowledge permissions={['knowledge.read', 'knowledge.write']} />);
    await screen.findByText('还没有知识库');

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /新建知识库/ }));
    await user.type(screen.getByPlaceholderText('例如：产品手册'), '产品手册');
    await user.click(screen.getByRole('button', { name: /^创建$/ }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) => init?.method === 'POST' && urlOf(input).endsWith('/api/knowledge-bases'),
        ),
      ).toBe(true),
    );

    const createCall = fetchMock.mock.calls.find(
      ([input, init]) => init?.method === 'POST' && urlOf(input).endsWith('/api/knowledge-bases'),
    );
    expect(createCall).toBeTruthy();
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({ name: '产品手册' });

    const headers = new Headers(createCall?.[1]?.headers);
    expect(headers.get('x-admin-confirmation')).toBe('nonce-9');
    expect(headers.get('authorization')).toBe('Bearer test-token');

    const confirmationCall = fetchMock.mock.calls.find(([input]) => urlOf(input).endsWith('/api/confirmations'));
    expect(JSON.parse(String(confirmationCall?.[1]?.body))).toMatchObject({
      method: 'POST',
      path: '/knowledge-bases',
      body: { name: '产品手册' },
    });
    expect(window.prompt).toHaveBeenCalled();
  });

  it('does not call the API when the confirmation prompt is cancelled', async () => {
    const fetchMock = setup({
      'GET /api/knowledge-bases': { ok: true, bases: [] },
    });
    vi.mocked(window.prompt).mockReturnValue('取消');

    renderWithProviders(<Knowledge permissions={['knowledge.read', 'knowledge.write']} />);
    await screen.findByText('还没有知识库');

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /新建知识库/ }));
    await user.type(screen.getByPlaceholderText('例如：产品手册'), '产品手册');
    await user.click(screen.getByRole('button', { name: /^创建$/ }));

    await waitFor(() => expect(window.prompt).toHaveBeenCalled());
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    expect(screen.queryByText(/操作已取消/)).not.toBeInTheDocument();
  });

  it('loads documents, search hits and bindings for the selected base', async () => {
    setup({
      'GET /api/knowledge-bases': { ok: true, bases: [baseFixture] },
      ...detailRoutes,
      'GET /api/knowledge-bases/kb-one/search': {
        ok: true,
        results: [{ documentId: 'doc-1', chunkId: 'chunk-3', index: 3, text: '退货需要在 7 天内提交。', score: 4 }],
      },
    });

    renderWithProviders(<Knowledge permissions={['knowledge.read', 'knowledge.delete']} />);
    const user = userEvent.setup();

    await user.click(await screen.findByText('产品手册'));
    expect(await screen.findByText('退换货政策')).toBeInTheDocument();
    expect(screen.getByText('2.0 KiB')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: '检索' }));
    await user.type(screen.getByLabelText('检索关键词'), '退货');
    await user.click(screen.getByRole('button', { name: /^检索$/ }));
    expect(await screen.findByText('退货需要在 7 天内提交。')).toBeInTheDocument();
    expect(screen.getByText('得分 4')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /绑定/ }));
    expect(await screen.findByText('moho')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /解绑/ })).toBeInTheDocument();
  });
});
