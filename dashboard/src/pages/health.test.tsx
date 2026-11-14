import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../test/render';
import { mockFetch, botFixture, jsonResponse } from '../test/fixtures';
import { setSessionToken } from '../lib/api';
import { Health } from './health';

const NOW = '2026-11-14T09:00:00.000Z';

const METRICS = {
  metrics: {
    ai: { count: 12, failures: 1, p50Ms: 120, p95Ms: 480, averageMs: 150 },
    embedding: { count: 4, failures: 0, p50Ms: 20, p95Ms: 35, averageMs: 24 },
    rerank: { count: 0, failures: 0, p50Ms: 0, p95Ms: 0, averageMs: 0 },
    cache: {
      world: { hits: 8, misses: 2, ratio: 0.8 },
      device: { hits: 3, misses: 1, ratio: 0.75 },
    },
  },
};

const ACTIONS = {
  actions: [
    { id: 'runtime.status', title: 'Runtime status', risk: 'read', confirmation: false, description: 'Read bot snapshots.' },
    { id: 'plugin.reload', title: 'Reload plugin', risk: 'reversible', confirmation: true, description: 'Reload one plugin.' },
  ],
};

function routes(overrides: Record<string, unknown> = {}) {
  return {
    'GET /api/admin/health': { health: { runtime: 'up', bots: 2 } },
    'GET /api/metrics': METRICS,
    'GET /api/status': {
      now: NOW,
      bots: [
        botFixture(),
        botFixture({ id: 'second', name: 'Second', running: false, gateway: { connected: false, ping: -1, reconnects: 2 }, sessions: 1 }),
      ],
    },
    'GET /api/admin/actions': ACTIONS,
    ...overrides,
  };
}

function setup(overrides: Record<string, unknown> = {}) {
  vi.stubGlobal('fetch', mockFetch(routes(overrides)));
  setSessionToken('test-token');
}

beforeEach(() => {
  setSessionToken('test-token');
});

afterEach(() => {
  setSessionToken('');
  vi.unstubAllGlobals();
});

describe('Health', () => {
  it('renders the health snapshot and the runtime metrics', async () => {
    setup();

    renderWithProviders(<Health permissions={['status.read', 'metrics.read']} />);

    // Health snapshot: runtime === 'up' rendered as the StatCard note.
    expect(await screen.findByText('快照：up')).toBeInTheDocument();
    expect(screen.getAllByText('运行中').length).toBeGreaterThan(0);
    // Metrics: structural latency table + cache hit-rate, never a raw dump.
    expect(await screen.findByText('AI 推理')).toBeInTheDocument();
    expect(screen.getByText('120 ms')).toBeInTheDocument();
    expect(screen.getByText('480 ms')).toBeInTheDocument();
    expect(await screen.findByText('80%')).toBeInTheDocument();
    expect(screen.getByText(/3 个延迟指标 · 2 个缓存指标/)).toBeInTheDocument();
  });

  it('renders a row per bot with gateway health', async () => {
    setup();

    renderWithProviders(<Health permissions={[]} />);

    expect(await screen.findByText('MohoBot')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
    expect(screen.getByText('2 个已注册实例')).toBeInTheDocument();
    expect(screen.getAllByText('42 ms').length).toBeGreaterThan(0);
    expect(screen.getAllByText('已连接').length).toBeGreaterThan(0);
    expect(screen.getAllByText('离线').length).toBeGreaterThan(0);
  });

  it('renders the action catalog with risk pills', async () => {
    setup();

    renderWithProviders(<Health permissions={['admin.actions.read']} />);

    expect(await screen.findByText('Runtime status')).toBeInTheDocument();
    expect(screen.getByText('Reload plugin')).toBeInTheDocument();
    expect(screen.getByText('2 项已注册的管理操作')).toBeInTheDocument();
    expect(screen.getByText('只读')).toBeInTheDocument();
    expect(screen.getByText('可逆')).toBeInTheDocument();
    expect(screen.getByText('需确认')).toBeInTheDocument();
  });

  it('shows the empty state when no bots are registered', async () => {
    setup({ 'GET /api/status': { now: NOW, bots: [] } });

    renderWithProviders(<Health permissions={[]} />);

    expect(await screen.findByText('没有运行实例')).toBeInTheDocument();
  });

  it('degrades gracefully when metrics fail while health still renders', async () => {
    setup({ 'GET /api/metrics': () => jsonResponse({ error: 'metrics down' }, 500) });

    renderWithProviders(<Health permissions={[]} />);

    // Health snapshot still rendered.
    expect(await screen.findByText('快照：up')).toBeInTheDocument();
    expect(screen.getByText('MohoBot')).toBeInTheDocument();
    // Metrics failure surfaced as a Notice, both as a section banner and inline.
    expect(screen.getAllByText(/运行指标不可用/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/metrics down/).length).toBeGreaterThan(0);
    // The rest of the page is not blanked out.
    expect(screen.getByText('能力清单')).toBeInTheDocument();
  });
});
