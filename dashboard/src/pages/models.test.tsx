import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../test/render';
import { mockFetch, jsonResponse } from '../test/fixtures';
import { setSessionToken } from '../lib/api';
import { Models } from './models';

function setup(routes: Parameters<typeof mockFetch>[0]) {
  vi.stubGlobal('fetch', mockFetch(routes));
  setSessionToken('test-token');
}

beforeEach(() => {
  setSessionToken('test-token');
});

afterEach(() => {
  setSessionToken('');
  vi.unstubAllGlobals();
});

const catalogModel = {
  id: 'nvidia/nemotron-3.5-lightning-30b-a3b',
  name: 'Nemotron 3.5 Lightning',
  provider: 'NVIDIA',
  contextLength: 131072,
  capabilities: ['chat', 'reasoning'],
  freeEndpoint: true,
  description: 'Fast agentic MoE model',
};

const fullRoutes = () => ({
  'GET /api/models': {
    catalog: {
      source: 'https://build.nvidia.com/models',
      fetchedAt: new Date().toISOString(),
      totalModels: 124,
      freeEndpointCount: 57,
      models: [catalogModel, { ...catalogModel, id: 'meta/muse-glimmer-30b', name: 'Muse Glimmer', provider: 'Meta' }],
    },
    recommendations: [catalogModel],
  },
  'GET /api/models/health': {
    health: {
      moho: {
        generatedAt: Date.now(),
        profiles: [
          { profileId: 'reply', modelId: 'nvidia/nemotron-3.5-lightning-30b-a3b', availability: 'available', circuit: 'closed', latencyMs: 210, consecutiveFailures: 0 },
          { profileId: 'planner', modelId: 'meta/muse-glimmer-30b', availability: 'unavailable', circuit: 'open', consecutiveFailures: 3 },
        ],
      },
    },
  },
  'GET /api/models/dashboard': {
    dashboard: {
      generatedAt: Date.now(),
      totals: { bots: 1, running: 1, models: 2, availableModels: 1 },
      bots: [{
        botId: 'moho', botName: 'MohoBot', running: true, provider: 'NVIDIA', model: 'nemotron-3.5', sessions: 4,
        health: { models: [{ profileId: 'reply', modelId: 'nemotron-3.5', availability: 'available', circuit: 'closed', consecutiveFailures: 0 }] },
        usage: { calls: 2, input: 10, output: 20 },
      }],
      providers: [{ provider: 'NVIDIA', modelCount: 2, availableCount: 1, avgLatencyMs: 180, models: [] }],
      events: [{ at: Date.now(), kind: 'fallback', lane: 'planner', model: 'nemotron-3.5', detail: 'planner fallback engaged' }],
    },
  },
});

describe('Models', () => {
  it('renders catalog rows and stat cards from the mocked endpoints', async () => {
    setup(fullRoutes());

    renderWithProviders(<Models permissions={['models.read']} />);

    expect(await screen.findByText('Nemotron 3.5 Lightning')).toBeInTheDocument();
    expect(screen.getByText('Muse Glimmer')).toBeInTheDocument();
    expect(screen.getByText(/条目 2 \/ 收录 124/)).toBeInTheDocument();
    // usage drill-down button only appears on the ops tab; stats always render
    expect(screen.getByText('目录模型数')).toBeInTheDocument();
  });

  it('shows the empty state when the catalog has no models', async () => {
    setup({
      'GET /api/models': { catalog: { source: 'test', fetchedAt: new Date().toISOString(), models: [] } },
      'GET /api/models/health': { health: {} },
      'GET /api/models/dashboard': { dashboard: { generatedAt: Date.now(), totals: { bots: 0, running: 0, models: 0, availableModels: 0 }, bots: [], providers: [], events: [] } },
    });

    renderWithProviders(<Models permissions={['models.read']} />);

    expect(await screen.findByText('目录为空')).toBeInTheDocument();
  });

  it('shows an error state when the catalog endpoint returns 500, other panels still render', async () => {
    setup({
      'GET /api/models': () => jsonResponse({ error: 'boom' }, 500),
      'GET /api/models/health': { health: { moho: { generatedAt: Date.now(), profiles: [{ profileId: 'reply', modelId: 'm1', availability: 'available', circuit: 'closed', consecutiveFailures: 0 }] } } },
      'GET /api/models/dashboard': fullRoutes()['GET /api/models/dashboard'],
    });

    renderWithProviders(<Models permissions={['models.read']} />);

    expect(await screen.findByText(/部分数据源不可用/)).toBeInTheDocument();
    // degraded: catalog panel surfaces its own error with retry, health still works
    expect(screen.getAllByText(/模型目录/).length).toBeGreaterThan(0);
    await screen.findByRole('button', { name: /重试/ });
    // health data loaded independently of the failed catalog
    expect(screen.getByText('1/1')).toBeInTheDocument();
  });

  it('renders health and dashboard panel values from the mocked snapshots', async () => {
    setup(fullRoutes());

    renderWithProviders(<Models permissions={['models.read']} />);

    expect(await screen.findByText('1/2')).toBeInTheDocument(); // 健康状态 stat card

    // health tab shows profiles
    (await screen.findByRole('tab', { name: /健康/ })).click();
    expect(await screen.findByText('planner')).toBeInTheDocument();
    expect(screen.getByText('reply')).toBeInTheDocument();
    expect(screen.getAllByText('可用').length).toBeGreaterThan(0);
    expect(screen.getByText('断开')).toBeInTheDocument();

    // ops tab shows the dashboard
    (await screen.findByRole('tab', { name: /运营/ })).click();
    expect(await screen.findByText('MohoBot')).toBeInTheDocument();
    expect(screen.getByText(/planner fallback engaged/)).toBeInTheDocument();
    expect(screen.getByText('回退事件')).toBeInTheDocument();
  });

  it('opens the usage drill-down modal for a bot', async () => {
    setup({
      ...fullRoutes(),
      'GET /api/models/usage/moho': {
        usage: {
          botId: 'moho', botName: 'MohoBot', running: true, provider: 'NVIDIA', model: 'nemotron-3.5',
          health: { models: [] },
          usage: [{ module: 'reply', name: 'chat', calls: 7, input: 120, output: 340 }],
        },
      },
    });

    renderWithProviders(<Models permissions={['models.read']} />);

    (await screen.findByRole('tab', { name: /运营/ })).click();
    const button = await screen.findByRole('button', { name: '用量' });
    button.click();
    expect(await screen.findByText(/模型用量 · MohoBot/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('120')).toBeInTheDocument());
  });

  it('handles a 404 usage drill-down gracefully', async () => {
    setup({
      ...fullRoutes(),
      'GET /api/models/usage/moho': () => jsonResponse({ error: 'bot not found' }, 404),
    });

    renderWithProviders(<Models permissions={['models.read']} />);

    (await screen.findByRole('tab', { name: /运营/ })).click();
    const button = await screen.findByRole('button', { name: '用量' });
    button.click();
    await waitFor(() => expect(screen.getByText(/bot not found/)).toBeInTheDocument());
  });
});
