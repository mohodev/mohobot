import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../test/render';
import { mockFetch, jsonResponse } from '../test/fixtures';
import { setSessionToken } from '../lib/api';
import { World } from './world';

function worldFixture(overrides: Record<string, unknown> = {}) {
  return {
    clock: '2026-11-14T10:30:00.000Z',
    weather: 'rain',
    location: '上海',
    activity: '在家休息',
    mood: { energy: 0.4, sociability: 0.6, curiosity: 0.7, stress: 0.8 },
    events: [{ id: 'evt-1', type: 'social', text: '和粉丝聊天', at: '2026-11-14T10:00:00.000Z' }],
    schedule: [
      { id: 'sched-1', at: Date.parse('2026-11-15T12:00:00.000Z'), type: 'concert', text: '线上演出', trust: 'candidate' },
    ],
    appliedPhases: [],
    ...overrides,
  };
}

function scheduleFixture() {
  return [
    { id: 'sched-1', at: Date.parse('2026-11-15T12:00:00.000Z'), type: 'concert', text: '线上演出', trust: 'candidate' },
  ];
}

function routes(overrides: Record<string, unknown> = {}) {
  return {
    'GET /api/world': { world: worldFixture() },
    'GET /api/world/schedule': { schedule: scheduleFixture(), domains: [{ id: 'world:shared', botId: 'moho', strategy: 'shared', createdAt: '2026-11-01T00:00:00.000Z' }] },
    'GET /api/world/day-plan': { plan: { date: '2026-11-14', source: 'rules', items: [{ at: '08:00', activity: '醒来', location: 'online', reason: '开始一天', energyCost: 0.08 }] } },
    'GET /api/world/trace': { traces: [] },
    ...overrides,
  };
}

function setup(overrides: Record<string, unknown> = {}) {
  const fetchMock = mockFetch(routes(overrides));
  vi.stubGlobal('fetch', fetchMock);
  setSessionToken('test-token');
  return fetchMock;
}

function calledPaths(fetchMock: ReturnType<typeof mockFetch>): string[] {
  return fetchMock.mock.calls.map(([input, init]) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, 'http://localhost');
    return `${(init?.method ?? 'GET').toUpperCase()} ${url.pathname}`;
  });
}

beforeEach(() => {
  setSessionToken('test-token');
});

afterEach(() => {
  setSessionToken('');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('World', () => {
  it('renders the world state, mood meters and recent events', async () => {
    setup();

    renderWithProviders(<World permissions={['world.read']} />);

    expect(await screen.findByText('上海')).toBeInTheDocument();
    expect(screen.getByText('在家休息')).toBeInTheDocument();
    expect(screen.getByText('有雨')).toBeInTheDocument();
    expect(screen.getByText('和粉丝聊天')).toBeInTheDocument();
    expect(screen.getByText('情绪状态')).toBeInTheDocument();
    expect(screen.getByText('最近事件')).toBeInTheDocument();
  });

  it('renders schedule rows with id, type, text and trust pill', async () => {
    setup();

    renderWithProviders(<World permissions={['world.read']} />);

    expect(await screen.findByText('线上演出')).toBeInTheDocument();
    expect(screen.getByText('sched-1')).toBeInTheDocument();
    expect(screen.getByText('concert')).toBeInTheDocument();
    expect(screen.getByText('候选')).toBeInTheDocument();
    expect(screen.getByText(/1 条 · 1 个世界域/)).toBeInTheDocument();
  });

  it('shows the empty state when there are no events or scheduled items', async () => {
    setup({
      'GET /api/world': { world: worldFixture({ events: [], schedule: [] }) },
      'GET /api/world/schedule': { schedule: [], domains: [] },
      'GET /api/world/day-plan': { plan: { date: '2026-11-14', source: 'rules', items: [] } },
    });

    renderWithProviders(<World permissions={['world.read']} />);

    expect(await screen.findByText('暂无世界事件')).toBeInTheDocument();
    expect(screen.getByText('暂无计划日程')).toBeInTheDocument();
    expect(screen.getByText('暂无当日计划')).toBeInTheDocument();
  });

  it('shows an error state when the world endpoint returns 500', async () => {
    setup({ 'GET /api/world': () => jsonResponse({ error: 'world boom' }, 500) });

    renderWithProviders(<World permissions={['world.read']} />);

    expect(await screen.findByText('world boom')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
  });

  it('hides write controls and shows a read-only notice without world.write', async () => {
    setup();

    renderWithProviders(<World permissions={['world.read']} />);

    expect((await screen.findAllByText(/只读/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /推进 Tick/ })).toBeNull();
  });

  it('posts to the unconfirmed tick endpoint when world.write is granted', async () => {
    const fetchMock = setup({ 'POST /api/world/tick': { ok: true, world: worldFixture({ activity: '演出中' }) } });

    renderWithProviders(<World permissions={['world.read', 'world.write']} />);

    fireEvent.click(await screen.findByRole('button', { name: /推进 Tick/ }));

    await waitFor(() => expect(calledPaths(fetchMock)).toContain('POST /api/world/tick'));
    expect(calledPaths(fetchMock)).not.toContain('POST /api/confirmations');
  });

  it('runs the confirmation nonce flow for the trust endpoint', async () => {
    const fetchMock = setup({
      'POST /api/confirmations': { confirmation: { nonce: 'nonce-1' } },
      'POST /api/world/schedule/sched-1/trust': { ok: true, world: worldFixture() },
    });
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('确认');

    renderWithProviders(<World permissions={['world.read', 'world.confirm']} />);

    fireEvent.click(await screen.findByRole('button', { name: '确认' }));

    await waitFor(() => expect(calledPaths(fetchMock)).toContain('POST /api/world/schedule/sched-1/trust'));
    expect(calledPaths(fetchMock)).toContain('POST /api/confirmations');
    expect(prompt).toHaveBeenCalled();

    const trustCall = fetchMock.mock.calls.find(([input]) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      return new URL(raw, 'http://localhost').pathname === '/api/world/schedule/sched-1/trust';
    });
    const headers = new Headers(trustCall?.[1]?.headers);
    expect(headers.get('X-Admin-Confirmation')).toBe('nonce-1');
  });
});
