import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import { cleanup, renderWithProviders } from '../test/render';
import { mockFetch, jsonResponse } from '../test/fixtures';
import { setSessionToken } from '../lib/api';
import type { FutureTask } from '../lib/types';
import { FutureTasks } from './futuretasks';

function taskFixture(overrides: Partial<FutureTask> = {}): FutureTask {
  return {
    id: 'task-1',
    type: 'world.tick',
    status: 'pending',
    owner: 'admin-1',
    scheduledAt: Date.now() + 60_000,
    attempts: 1,
    maxRetries: 3,
    lastError: '',
    payload: { botId: 'moho' },
    ...overrides,
  };
}

const CONTROL = ['tasks.read', 'tasks.control'];

beforeEach(() => {
  setSessionToken('test-token');
});

afterEach(() => {
  setSessionToken('');
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 任务队列所在的面板，避免与筛选组件的同名文案冲突。 */
function queuePanel(): HTMLElement {
  return screen.getByRole('heading', { name: '任务队列' }).closest('section') as HTMLElement;
}

describe('FutureTasks', () => {
  it('renders rows from a mocked successful GET', async () => {
    vi.stubGlobal('fetch', mockFetch({
      'GET /api/tasks/future': {
        tasks: [
          taskFixture({ id: 'task-1', type: 'world.tick', status: 'pending', owner: 'admin-1', payload: { botId: 'moho' } }),
          taskFixture({ id: 'task-2', type: 'discord.deliver', status: 'failed', owner: 'admin-1', attempts: 3, maxRetries: 3, lastError: '投递超时', payload: { channelId: '123', dedupeKey: 'k:1', content: '早上好' } }),
        ],
      },
    }));

    renderWithProviders(<FutureTasks permissions={CONTROL} />);

    expect(await screen.findByText('task-1')).toBeInTheDocument();
    const queue = within(queuePanel());
    expect(queue.getByText('task-2')).toBeInTheDocument();
    expect(queue.getByText('待执行')).toBeInTheDocument();
    expect(queue.getByText('已失败')).toBeInTheDocument();
    expect(queue.getByText('投递超时')).toBeInTheDocument();
    expect(queue.getByText('3/3')).toBeInTheDocument();
    // 载荷摘要来自真实 payload
    expect(queue.getByText(/botId: moho/)).toBeInTheDocument();
    expect(queue.getByText(/#123 · 早上好 · k:1/)).toBeInTheDocument();
  });

  it('shows the empty state when the API returns an empty list', async () => {
    vi.stubGlobal('fetch', mockFetch({ 'GET /api/tasks/future': { tasks: [] } }));

    renderWithProviders(<FutureTasks permissions={CONTROL} />);

    expect(await screen.findByText('没有未来任务')).toBeInTheDocument();
  });

  it('shows an error state when the GET returns 500', async () => {
    vi.stubGlobal('fetch', mockFetch({
      'GET /api/tasks/future': () => jsonResponse({ error: '内部错误' }, 500),
    }));

    renderWithProviders(<FutureTasks permissions={CONTROL} />);

    expect(await screen.findByText(/内部错误/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
  });

  it('hides mutating controls and shows 只读 without tasks.control', async () => {
    vi.stubGlobal('fetch', mockFetch({ 'GET /api/tasks/future': { tasks: [taskFixture({ status: 'uncertain' })] } }));

    renderWithProviders(<FutureTasks permissions={['tasks.read']} />);

    expect(await screen.findByText('task-1')).toBeInTheDocument();
    expect(screen.getByText(/只读/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /调度任务/ })).toBeNull();
    expect(within(queuePanel()).queryByRole('button', { name: /对账/ })).toBeNull();
  });

  it('schedules a world.tick task through the confirmation flow', async () => {
    const prompt = vi.fn(() => '确认');
    vi.stubGlobal('prompt', prompt);
    const fetchMock = mockFetch({
      'GET /api/tasks/future': { tasks: [] },
      'POST /api/confirmations': { confirmation: { nonce: 'nonce-1' } },
      'POST /api/tasks/future/schedule': { task: taskFixture({ id: 'task-new', payload: { botId: 'moho' } }) },
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(<FutureTasks permissions={CONTROL} />);
    await screen.findByText('没有未来任务');

    fireEvent.click(screen.getByRole('button', { name: /调度任务/ }));
    fireEvent.change(await screen.findByTestId('schedule-type'), { target: { value: 'world.tick' } });
    fireEvent.change(screen.getByTestId('schedule-botId'), { target: { value: 'moho' } });
    fireEvent.change(screen.getByTestId('schedule-maxRetries'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: /确认调度/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/tasks/future/schedule', expect.objectContaining({ method: 'POST' }));
    });

    const call = fetchMock.mock.calls.find(([input]) => input === '/api/tasks/future/schedule');
    const init = call?.[1] as RequestInit;
    const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(sent).toMatchObject({ type: 'world.tick', payload: { botId: 'moho' }, maxRetries: 5 });
    expect(Object.keys(sent.payload as Record<string, unknown>)).toEqual(['botId']);

    // 确认 nonce 流程已执行，且带上了确认头。
    expect(prompt).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith('/api/confirmations', expect.objectContaining({ method: 'POST' }));
    const headers = new Headers(init.headers);
    expect(headers.get('x-admin-confirmation')).toBe('nonce-1');

    expect(await screen.findByText(/已调度任务/)).toBeInTheDocument();
  });

  it('rejects an invalid discord.deliver payload before calling the API', async () => {
    const fetchMock = mockFetch({
      'GET /api/tasks/future': { tasks: [] },
      'POST /api/confirmations': { confirmation: { nonce: 'nonce-1' } },
      'POST /api/tasks/future/schedule': { task: taskFixture() },
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('prompt', vi.fn(() => '确认'));

    renderWithProviders(<FutureTasks permissions={CONTROL} />);
    await screen.findByText('没有未来任务');

    fireEvent.click(screen.getByRole('button', { name: /调度任务/ }));
    fireEvent.change(await screen.findByTestId('schedule-type'), { target: { value: 'discord.deliver' } });
    fireEvent.change(screen.getByTestId('schedule-botId'), { target: { value: 'moho' } });
    fireEvent.change(screen.getByTestId('schedule-channelId'), { target: { value: 'abc' } });
    fireEvent.change(screen.getByTestId('schedule-dedupeKey'), { target: { value: 'k:1' } });
    fireEvent.change(screen.getByTestId('schedule-content'), { target: { value: '你好' } });
    fireEvent.click(screen.getByRole('button', { name: /确认调度/ }));

    expect(await screen.findByText(/必须是 1~32 位数字的频道 ID/)).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => input === '/api/tasks/future/schedule')).toBe(false);
  });

  it('reconciles an uncertain discord.deliver task via the confirmation flow', async () => {
    vi.stubGlobal('prompt', vi.fn(() => '确认'));
    const fetchMock = mockFetch({
      'GET /api/tasks/future': {
        tasks: [taskFixture({ id: 'task-uncertain', type: 'discord.deliver', status: 'uncertain', payload: { botId: 'moho', channelId: '456', dedupeKey: 'k:2', content: 'hi' } })],
      },
      'POST /api/confirmations': { confirmation: { nonce: 'nonce-2' } },
      'POST /api/tasks/future/task-uncertain/reconcile': {
        task: taskFixture({ id: 'task-uncertain', type: 'discord.deliver', status: 'completed' }),
        record: { status: 'delivered', error: '' },
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(<FutureTasks permissions={CONTROL} />);
    await screen.findByText('task-uncertain');

    fireEvent.click(screen.getByRole('button', { name: /对账/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/tasks/future/task-uncertain/reconcile', expect.objectContaining({ method: 'POST' }));
    });
    expect(await screen.findByText('对账结果')).toBeInTheDocument();
    expect(within(screen.getByRole('dialog', { name: '对账结果' })).getByText('已完成')).toBeInTheDocument();
  });
});
