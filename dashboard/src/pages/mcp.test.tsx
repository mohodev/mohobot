import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../test/render';
import { jsonResponse, mockFetch } from '../test/fixtures';
import { setSessionToken } from '../lib/api';
import { Mcp } from './mcp';

const RULES = [
  { pattern: 'search.web', minRole: 'viewer' },
  { pattern: 'system.*', minRole: 'admin' },
];

const SERVERS = [
  { id: 'demo', transport: 'stdio', initialized: true, toolCount: 2 },
  { id: 'down', transport: 'sse', initialized: false, toolCount: 0, error: '连接失败' },
];

const TOOLS = [
  {
    server: 'demo',
    name: 'search.web',
    description: '搜索网页',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
  },
  { server: 'demo', name: 'config.set', description: '写入配置', inputSchema: { type: 'object', properties: {} } },
];

const ENTRIES = [
  {
    id: 'audit-1',
    at: new Date().toISOString(),
    tool: 'search.web',
    caller: 'root (admin)',
    outcome: 'allowed',
    detail: 'ok',
    argsRedacted: 'q=hello',
  },
  {
    id: 'audit-2',
    at: new Date().toISOString(),
    tool: 'config.set',
    caller: 'u1 (viewer)',
    outcome: 'denied',
    detail: 'requires admin',
    argsRedacted: 'mode=[REDACTED]',
  },
];

type Routes = Parameters<typeof mockFetch>[0];

function setup(routes: Routes) {
  const fetchMock = mockFetch(routes);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function successfulRoutes(overrides: Routes = {}): Routes {
  return {
    'GET /api/mcp/policy': { rules: RULES },
    'GET /api/mcp/tools': { servers: SERVERS, tools: TOOLS },
    'GET /api/mcp/audit': { entries: ENTRIES },
    ...overrides,
  };
}

function responseBodyFor(fetchMock: ReturnType<typeof mockFetch>, path: string): Record<string, unknown> | undefined {
  const call = fetchMock.mock.calls.find(([input, init]) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return new URL(raw, 'http://localhost').pathname === path && (init?.method ?? 'GET').toUpperCase() === 'POST';
  });
  if (!call) return undefined;
  const body = call[1]?.body;
  return typeof body === 'string' ? (JSON.parse(body) as Record<string, unknown>) : undefined;
}

beforeEach(() => {
  setSessionToken('test-token');
});

afterEach(() => {
  setSessionToken('');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Mcp', () => {
  it('renders policy rules, servers, tools and audit rows', async () => {
    setup(successfulRoutes());
    renderWithProviders(<Mcp permissions={['mcp.read', 'mcp.call']} />);

    expect(await screen.findByText('工具匹配模式')).toBeInTheDocument();
    expect(screen.getByText('最低角色')).toBeInTheDocument();
    expect(screen.getAllByText('search.web').length).toBeGreaterThan(0);
    expect(screen.getByText('system.*')).toBeInTheDocument();

    // Server panel: both a ready and an errored server are shown from real fields.
    expect(screen.getByText('已就绪')).toBeInTheDocument();
    expect(screen.getByText('未就绪')).toBeInTheDocument();
    expect(screen.getByText('连接失败')).toBeInTheDocument();

    // Tools panel: description and derived schema field count.
    expect(screen.getByText('搜索网页')).toBeInTheDocument();
    expect(screen.getAllByText('1 个字段').length).toBeGreaterThan(0);

    // Audit panel: caller, outcome pill and redacted arguments.
    expect(screen.getByText('root (admin)')).toBeInTheDocument();
    expect(screen.getByText('allowed')).toBeInTheDocument();
    expect(screen.getByText('denied')).toBeInTheDocument();
    expect(screen.getByText('q=hello')).toBeInTheDocument();
  });

  it('shows the viewer low-privilege note', async () => {
    setup(successfulRoutes());
    renderWithProviders(<Mcp permissions={[]} />);

    expect(await screen.findByText(/固定使用低权限/)).toBeInTheDocument();
    // Without mcp.call the call form is replaced by a read-only note.
    expect(screen.getByText(/缺少/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /调用工具并记录审计/ })).not.toBeInTheDocument();
  });

  it('renders empty states when every list is empty', async () => {
    setup({
      'GET /api/mcp/policy': { rules: [] },
      'GET /api/mcp/tools': { servers: [], tools: [] },
      'GET /api/mcp/audit': { entries: [] },
    });
    renderWithProviders(<Mcp permissions={['mcp.call']} />);

    expect(await screen.findByText('没有可显示的策略')).toBeInTheDocument();
    expect(screen.getByText('没有已配置的 MCP Server')).toBeInTheDocument();
    expect(screen.getByText('暂时没有可调用工具')).toBeInTheDocument();
    expect(screen.getByText('暂无 MCP 调用记录')).toBeInTheDocument();
  });

  it('shows a per-section Notice when one load fails while the others render', async () => {
    setup(successfulRoutes({ 'GET /api/mcp/policy': () => jsonResponse({ error: 'boom' }, 500) }));
    renderWithProviders(<Mcp permissions={['mcp.read']} />);

    expect(await screen.findByText(/策略：boom/)).toBeInTheDocument();
    // The Server panel still rendered its real data despite the policy failure.
    expect(screen.getAllByText('demo').length).toBeGreaterThan(0);
    expect(screen.getByText('已就绪')).toBeInTheDocument();
  });

  it('runs the confirmation flow and POSTs the call payload', async () => {
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('确认');
    const fetchMock = setup(successfulRoutes({
      'POST /api/confirmations': { confirmation: { nonce: 'nonce-1' } },
      'POST /api/mcp/call': { result: { content: [{ type: 'text', text: '来自 search.web 的结果' }] } },
    }));
    renderWithProviders(<Mcp permissions={['mcp.call']} />);

    // Wait for the load, then edit the JSON arguments textarea.
    await screen.findByText('工具匹配模式');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '{"q":"hi"}' } });
    fireEvent.click(screen.getByRole('button', { name: /调用工具并记录审计/ }));

    await waitFor(() => expect(responseBodyFor(fetchMock, '/api/mcp/call')).toBeDefined());
    expect(promptSpy).toHaveBeenCalledTimes(1);
    expect(responseBodyFor(fetchMock, '/api/mcp/call')).toEqual({
      server: 'demo',
      tool: 'search.web',
      arguments: { q: 'hi' },
    });
    expect(await screen.findByText('来自 search.web 的结果')).toBeInTheDocument();
  });

  it('rejects invalid JSON client-side without calling the API', async () => {
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('确认');
    const fetchMock = setup(successfulRoutes({
      'POST /api/confirmations': { confirmation: { nonce: 'nonce-1' } },
      'POST /api/mcp/call': { result: { content: [] } },
    }));
    renderWithProviders(<Mcp permissions={['mcp.call']} />);

    await screen.findByText('工具匹配模式');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '{not valid json' } });
    fireEvent.click(screen.getByRole('button', { name: /调用工具并记录审计/ }));

    expect(await screen.findByText('参数必须是有效 JSON。')).toBeInTheDocument();
    expect(promptSpy).not.toHaveBeenCalled();
    expect(responseBodyFor(fetchMock, '/api/mcp/call')).toBeUndefined();
    expect(responseBodyFor(fetchMock, '/api/confirmations')).toBeUndefined();
  });
});
