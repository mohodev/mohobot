import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '../test/render';
import { mockFetch, jsonResponse, seedPermissions, taskFixture } from '../test/fixtures';
import { setSessionToken } from '../lib/api';
import { Tasks } from './tasks';

const CONTROL = ['tasks.read', 'tasks.control'];

const intervalTask = taskFixture({
  id: 'task-1',
  name: 'housekeeping',
  kind: 'interval',
  state: 'pending',
  runs: 4,
  errors: 0,
  lastRunMs: 1200,
  startedAt: Date.now() - 60_000,
});

const runningTask = taskFixture({
  id: 'task-2',
  name: 'world-tick',
  kind: 'interval',
  state: 'running',
  runs: 9,
  errors: 2,
  lastErrorCode: 'abc123def456',
});

const oneshotTask = taskFixture({
  id: 'task-3',
  name: 'model-health',
  kind: 'oneshot',
  state: 'done',
  runs: 1,
});

beforeEach(() => {
  setSessionToken('test-token');
  seedPermissions(CONTROL);
});

afterEach(() => {
  setSessionToken('');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Tasks', () => {
  it('renders rows from a bare { items } response shape', async () => {
    vi.stubGlobal('fetch', mockFetch({
      'GET /api/tasks': { tasks: { items: [intervalTask, runningTask] } },
    }));

    renderWithProviders(<Tasks permissions={CONTROL} />);

    expect(await screen.findByText('housekeeping')).toBeInTheDocument();
    expect(screen.getByText('world-tick')).toBeInTheDocument();
    expect(screen.getByText('task-1')).toBeInTheDocument();
    expect(screen.getByText('等待中')).toBeInTheDocument();
    expect(screen.getByText('运行中')).toBeInTheDocument();
    // 真实数据列：耗时、类型
    expect(screen.getByText('1.20 s')).toBeInTheDocument();
    expect(screen.getAllByText('周期任务')).toHaveLength(2);
    // 在没有 OpsPage 元数据时不应出现分页控件
    expect(screen.queryByRole('button', { name: /下一页/ })).toBeNull();
  });

  it('renders rows from a full OpsPage response shape with pagination', async () => {
    vi.stubGlobal('fetch', mockFetch({
      'GET /api/tasks': { tasks: { items: [intervalTask], limit: 25, offset: 0, hasMore: true } },
    }));

    renderWithProviders(<Tasks permissions={CONTROL} />);

    expect(await screen.findByText('housekeeping')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /下一页/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /上一页/ })).toBeDisabled();
  });

  it('shows the empty state when the API returns no tasks', async () => {
    vi.stubGlobal('fetch', mockFetch({ 'GET /api/tasks': { tasks: { items: [] } } }));

    renderWithProviders(<Tasks permissions={CONTROL} />);

    expect(await screen.findByText('没有匹配的任务')).toBeInTheDocument();
  });

  it('shows an error state when the GET returns 500', async () => {
    vi.stubGlobal('fetch', mockFetch({
      'GET /api/tasks': () => jsonResponse({ error: '任务服务不可用' }, 500),
    }));

    renderWithProviders(<Tasks permissions={CONTROL} />);

    expect(await screen.findByText(/任务服务不可用/)).toBeInTheDocument();
    expect(screen.getByText('重试')).toBeInTheDocument();
  });

  it('hides mutating controls and shows 只读 without tasks.control', async () => {
    vi.stubGlobal('fetch', mockFetch({
      'GET /api/tasks': { tasks: { items: [intervalTask] } },
    }));

    renderWithProviders(<Tasks permissions={['tasks.read']} />);

    expect(await screen.findByText('housekeeping')).toBeInTheDocument();
    expect(screen.getByText(/只读/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /暂停/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /立即执行/ })).toBeNull();
  });

  it('pauses a task through the confirmation nonce flow', async () => {
    const prompt = vi.fn(() => '确认');
    vi.stubGlobal('prompt', prompt);
    const fetchMock = mockFetch({
      'GET /api/tasks': { tasks: { items: [intervalTask] } },
      'POST /api/confirmations': { confirmation: { nonce: 'nonce-1' } },
      'POST /api/tasks/task-1/pause': { task: taskFixture({ id: 'task-1', state: 'paused' }) },
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(<Tasks permissions={CONTROL} />);
    await screen.findByText('housekeeping');

    fireEvent.click(screen.getByRole('button', { name: /暂停/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/tasks/task-1/pause', expect.objectContaining({ method: 'POST' }));
    });

    // 确认提示 + 服务端 nonce 流程都已执行，并在写请求上带上确认头。
    expect(prompt).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith('/api/confirmations', expect.objectContaining({ method: 'POST' }));
    const call = fetchMock.mock.calls.find(([input]) => input === '/api/tasks/task-1/pause');
    const headers = new Headers((call?.[1] as RequestInit).headers);
    expect(headers.get('x-admin-confirmation')).toBe('nonce-1');

    expect(await screen.findByText(/已对任务 housekeeping 执行「暂停」/)).toBeInTheDocument();
  });

  it('does not call the pause endpoint when the confirmation is cancelled', async () => {
    vi.stubGlobal('prompt', vi.fn(() => '取消'));
    const fetchMock = mockFetch({
      'GET /api/tasks': { tasks: { items: [intervalTask] } },
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(<Tasks permissions={CONTROL} />);
    await screen.findByText('housekeeping');

    fireEvent.click(screen.getByRole('button', { name: /暂停/ }));

    await waitFor(() => expect(vi.mocked(window.prompt)).toHaveBeenCalled());
    expect(fetchMock.mock.calls.some(([input]) => input === '/api/tasks/task-1/pause')).toBe(false);
  });

  it('offers no control actions for a one-shot task', async () => {
    vi.stubGlobal('fetch', mockFetch({
      'GET /api/tasks': { tasks: { items: [oneshotTask] } },
    }));

    renderWithProviders(<Tasks permissions={CONTROL} />);

    expect(await screen.findByText('model-health')).toBeInTheDocument();
    expect(screen.getByText('一次性任务')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /暂停/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /立即执行/ })).toBeNull();
  });
});
