import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, screen, waitFor, renderWithProviders } from '../test/render';
import { auditFixture, jsonResponse, mockFetch, sessionFixture } from '../test/fixtures';
import { setSessionToken } from '../lib/api';
import { Sessions } from './sessions';

/**
 * 会话与审计 页面测试。
 *
 * 全部按真实响应形状（服务端 route 与 ops-control 的字段）构造 mock：
 *  - `GET /api/ops/sessions` → `{ sessions: OpsPage<OpsSession> }`
 *  - `GET /api/admin/audit` → `{ audit: OpsPage<OpsAudit> }`
 *  - `GET /api/ops/chat-log` / `discord-chat-log` → `{ messages }`
 *  - `DELETE /api/ops/sessions/:id` 走确认 nonce 流程
 */

function install(routes: Parameters<typeof mockFetch>[0]) {
  const fetchMock = mockFetch(routes);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Absolute request URLs seen by the fetch mock, in call order. */
function requestUrls(fetchMock: ReturnType<typeof mockFetch>): string[] {
  return fetchMock.mock.calls.map(([input]) => {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.toString();
    return input.url;
  });
}

function methodOf(init: RequestInit | undefined): string {
  return (init?.method ?? 'GET').toUpperCase();
}

beforeEach(() => {
  setSessionToken('test-token');
});

afterEach(() => {
  setSessionToken('');
  vi.unstubAllGlobals();
});

describe('Sessions 页面（会话与审计）', () => {
  it('渲染会话行并支持分页', async () => {
    const fetchMock = install({
      'GET /api/ops/sessions': {
        sessions: {
          items: [
            sessionFixture({ id: 'session:moho:chan-1', channelId: 'chan-1', summaryHash: 'abcd1234' }),
            sessionFixture({ id: 'session:moho:chan-2', channelId: 'chan-2', userId: 'user-2', deletedCount: 3, summaryHash: 'efgh5678' }),
          ],
          limit: 25,
          offset: 0,
          hasMore: true,
        },
      },
    });

    renderWithProviders(<Sessions permissions={['sessions.chat.read']} />);

    expect(await screen.findByText('chan-1')).toBeInTheDocument();
    expect(screen.getByText('chan-2')).toBeInTheDocument();
    expect(screen.getByText('abcd1234')).toBeInTheDocument();
    expect(screen.getByText('efgh5678')).toBeInTheDocument();
    // 首次请求带分页参数与默认 limit。
    expect(requestUrls(fetchMock).some((url) => url.includes('limit=25') && url.includes('offset=0'))).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /下一页/ }));

    await waitFor(() => {
      expect(requestUrls(fetchMock).some((url) => url.includes('offset=25'))).toBe(true);
    });
  });

  it('按 botId / channelId / userId 过滤并可重置', async () => {
    const fetchMock = install({
      'GET /api/ops/sessions': { sessions: { items: [sessionFixture({ channelId: 'chan-1' })], limit: 25, offset: 0, hasMore: false } },
    });

    renderWithProviders(<Sessions permissions={['sessions.chat.read']} />);
    expect(await screen.findByText('chan-1')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('按 botId 过滤'), { target: { value: 'moho' } });
    fireEvent.change(screen.getByLabelText('按 channelId 过滤'), { target: { value: 'chan-1' } });
    fireEvent.change(screen.getByLabelText('按 userId 过滤'), { target: { value: 'user-1' } });

    await waitFor(() => {
      expect(requestUrls(fetchMock).some((url) => url.includes('botId=moho') && url.includes('channelId=chan-1') && url.includes('userId=user-1'))).toBe(true);
    });

    const before = requestUrls(fetchMock).length;
    fireEvent.click(screen.getByRole('button', { name: '重置过滤' }));

    await waitFor(() => {
      const after = requestUrls(fetchMock).slice(before);
      expect(after.length).toBeGreaterThan(0);
      expect(after.at(-1)).not.toContain('botId=');
    });
  });

  it('会话为空时显示空状态', async () => {
    install({
      'GET /api/ops/sessions': { sessions: { items: [], limit: 25, offset: 0, hasMore: false } },
    });

    renderWithProviders(<Sessions permissions={['sessions.chat.read']} />);

    expect(await screen.findByText('暂无会话')).toBeInTheDocument();
  });

  it('会话接口 500 时显示错误状态', async () => {
    install({
      'GET /api/ops/sessions': () => jsonResponse({ error: 'storage offline' }, 500),
    });

    renderWithProviders(<Sessions permissions={['sessions.chat.read']} />);

    expect(await screen.findByText('storage offline')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
  });

  it('删除会话走确认 nonce 流程并发送 DELETE', async () => {
    const session = sessionFixture({ id: 'session:moho:chan-1', channelId: 'chan-1' });
    const fetchMock = install({
      'GET /api/ops/sessions': { sessions: { items: [session], limit: 25, offset: 0, hasMore: false } },
      'POST /api/confirmations': { confirmation: { nonce: 'nonce-123' } },
      [`DELETE /api/ops/sessions/${encodeURIComponent(session.id)}`]: { deleted: true },
    });
    const promptMock = vi.fn(() => '确认');
    vi.stubGlobal('prompt', promptMock);

    renderWithProviders(<Sessions permissions={['sessions.chat.read', 'sessions.chat.delete']} />);
    expect(await screen.findByText('chan-1')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^删除/ }));

    await waitFor(() => expect(promptMock).toHaveBeenCalledTimes(1));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => methodOf(init) === 'DELETE')).toBe(true);
    });

    const confirmationCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/api/confirmations'));
    expect(confirmationCall).toBeDefined();
    expect(JSON.parse(String((confirmationCall?.[1] as RequestInit).body))).toMatchObject({
      method: 'DELETE',
      path: `/ops/sessions/${encodeURIComponent(session.id)}`,
    });

    const deleteCall = fetchMock.mock.calls.find(([, init]) => methodOf(init) === 'DELETE');
    expect(new Headers((deleteCall?.[1] as RequestInit).headers).get('x-admin-confirmation')).toBe('nonce-123');

    // 删除成功后重新加载会话列表。
    await waitFor(() => {
      const sessionRequests = requestUrls(fetchMock).filter((url) => url.includes('/api/ops/sessions?'));
      expect(sessionRequests.length).toBeGreaterThan(1);
    });
    expect(await screen.findByText(/已删除会话/)).toBeInTheDocument();
  });

  it('缺少 sessions.chat.delete 权限时不显示删除按钮', async () => {
    install({
      'GET /api/ops/sessions': { sessions: { items: [sessionFixture({ channelId: 'chan-1' })], limit: 25, offset: 0, hasMore: false } },
    });

    renderWithProviders(<Sessions permissions={['sessions.chat.read']} />);

    expect(await screen.findByText('chan-1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^删除/ })).not.toBeInTheDocument();
    expect(screen.getByText('只读')).toBeInTheDocument();
  });

  it('渲染审计行（操作者 / 动作 / 方法路径 / 状态码 / 结果）', async () => {
    install({
      'GET /api/ops/sessions': { sessions: { items: [], limit: 25, offset: 0, hasMore: false } },
      'GET /api/admin/audit': {
        audit: {
          items: [
            auditFixture({ id: 'audit-1', actor: 'alice', action: 'ops.sessions.delete', method: 'DELETE', path: '/api/ops/sessions/session-1', status: 200, outcome: 'allowed' }),
            auditFixture({ id: 'audit-2', actor: 'bob', action: 'runtime.status', method: 'GET', path: '/api/status', status: 403, outcome: 'denied' }),
          ],
          limit: 25,
          offset: 0,
          hasMore: false,
        },
      },
      'GET /api/ops/operator-audit': { entries: [] },
      'GET /api/ops/operator-tools': { tools: [] },
    });

    renderWithProviders(<Sessions permissions={['sessions.chat.read', 'audit.read']} />);

    fireEvent.click(await screen.findByRole('tab', { name: /审计/ }));

    expect(await screen.findByText('alice')).toBeInTheDocument();
    expect(screen.getByText('ops.sessions.delete')).toBeInTheDocument();
    expect(screen.getByText('/api/ops/sessions/session-1')).toBeInTheDocument();
    expect(screen.getByText('bob')).toBeInTheDocument();
    expect(screen.getByText('403')).toBeInTheDocument();
    // "denied" 同时出现在结果 Pill 与结果过滤下拉里，因此按 Pill 精确定位。
    expect(screen.getAllByText('denied').filter((node) => node.classList.contains('pill'))).toHaveLength(1);
    expect(screen.getAllByText('allowed').filter((node) => node.classList.contains('pill'))).toHaveLength(1);
  });

  it('审计为空时显示空状态', async () => {
    install({
      'GET /api/ops/sessions': { sessions: { items: [], limit: 25, offset: 0, hasMore: false } },
      'GET /api/admin/audit': { audit: { items: [], limit: 25, offset: 0, hasMore: false } },
      'GET /api/ops/operator-audit': { entries: [] },
      'GET /api/ops/operator-tools': { tools: [] },
    });

    renderWithProviders(<Sessions permissions={['audit.read']} />);

    fireEvent.click(await screen.findByRole('tab', { name: /审计/ }));

    expect(await screen.findByText('暂无审计记录')).toBeInTheDocument();
  });

  it('审计接口 500 时显示错误状态', async () => {
    install({
      'GET /api/ops/sessions': { sessions: { items: [], limit: 25, offset: 0, hasMore: false } },
      'GET /api/admin/audit': () => jsonResponse({ error: 'audit unavailable' }, 500),
      'GET /api/ops/operator-audit': { entries: [] },
      'GET /api/ops/operator-tools': { tools: [] },
    });

    renderWithProviders(<Sessions permissions={['audit.read']} />);

    expect(await screen.findByText('audit unavailable')).toBeInTheDocument();
  });

  it('呼应审计过滤器时携带对应查询参数', async () => {
    const fetchMock = install({
      'GET /api/ops/sessions': { sessions: { items: [], limit: 25, offset: 0, hasMore: false } },
      'GET /api/admin/audit': { audit: { items: [], limit: 25, offset: 0, hasMore: false } },
      'GET /api/ops/operator-audit': { entries: [] },
      'GET /api/ops/operator-tools': { tools: [] },
    });

    renderWithProviders(<Sessions permissions={['audit.read']} />);

    fireEvent.change(await screen.findByLabelText('按操作者过滤'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('按动作过滤'), { target: { value: 'ops.sessions.delete' } });
    fireEvent.change(screen.getByLabelText('按方法过滤'), { target: { value: 'DELETE' } });
    fireEvent.change(screen.getByLabelText('按结果过滤'), { target: { value: 'denied' } });

    await waitFor(() => {
      expect(requestUrls(fetchMock).some((url) =>
        url.includes('/api/admin/audit?')
        && url.includes('actor=alice')
        && url.includes('action=ops.sessions.delete')
        && url.includes('method=DELETE')
        && url.includes('outcome=denied'))).toBe(true);
    });
  });

  it('渲染 Discord 双向日志并打开聊天记录弹窗', async () => {
    const session = sessionFixture({ id: 'session:moho:chan-1', channelId: 'chan-1' });
    install({
      'GET /api/ops/sessions': { sessions: { items: [session], limit: 25, offset: 0, hasMore: false } },
      'GET /api/ops/discord-chat-log': {
        messages: [
          { seq: 7, time: Date.now(), direction: 'in', botId: 'moho', channelId: 'chan-1', userId: 'user-1', summary: '你好呀', outcome: 'received' },
        ],
      },
      'GET /api/ops/chat-log': {
        messages: [
          { id: 1, channel_id: 'chan-1', author_id: 'user-1', username: '小明', content: '物理日志内容', mentions_bot: 1, bot_id: 'moho', ts: new Date().toISOString(), created_at: Date.now() },
        ],
      },
    });

    renderWithProviders(<Sessions permissions={['sessions.chat.read', 'chats.log.read']} />);

    expect(await screen.findByText('你好呀')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /聊天记录/ }));

    expect(await screen.findByText('物理日志内容')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: '聊天记录' })).toBeInTheDocument();
  });
});
