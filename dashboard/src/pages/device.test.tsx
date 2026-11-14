import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../test/render';
import { jsonResponse, mockFetch } from '../test/fixtures';
import { setSessionToken } from '../lib/api';
import type { DeviceState } from '../lib/types';
import { Device } from './device';

function deviceFixture(overrides: Partial<DeviceState> = {}): DeviceState {
  return {
    battery: 72,
    charging: false,
    network: 'wifi',
    screen: 'on',
    doNotDisturb: false,
    activity: 'idle',
    lastSeenAt: new Date().toISOString(),
    notificationCount: 0,
    habits: {
      checksPhoneWhileCharging: false,
      chargeBelow: 18,
      ignoresNotificationsWhile: ['sleeping'],
      delayedReplyProbability: 0.22,
    },
    ...overrides,
  };
}

function setup(routes: Parameters<typeof mockFetch>[0]) {
  const fetchMock = mockFetch(routes);
  vi.stubGlobal('fetch', fetchMock);
  setSessionToken('test-token');
  return fetchMock;
}

beforeEach(() => {
  setSessionToken('test-token');
});

afterEach(() => {
  cleanup();
  setSessionToken('');
  vi.unstubAllGlobals();
});

describe('Device', () => {
  it('renders the current battery, network and habits from a successful GET', async () => {
    setup({ 'GET /api/device': { device: deviceFixture({ network: 'cellular', notificationCount: 5 }) } });

    renderWithProviders(<Device permissions={['device.read']} />);

    expect(await screen.findByText('当前状态')).toBeInTheDocument();
    expect(screen.getAllByText('72%').length).toBeGreaterThan(0);
    expect(screen.getAllByText('蜂窝网络').length).toBeGreaterThan(0);
    expect(screen.getByText('行为习惯')).toBeInTheDocument();
    expect(screen.getByText('低电量阈值')).toBeInTheDocument();
    // Notification count is rendered as a real number from the response.
    expect(screen.getAllByText('5').length).toBeGreaterThan(0);
  });

  it('shows the empty state when the API omits the device payload', async () => {
    setup({ 'GET /api/device': {} });

    renderWithProviders(<Device permissions={['device.read']} />);

    expect(await screen.findByText('暂无设备状态')).toBeInTheDocument();
  });

  it('shows an error state when the GET returns 500', async () => {
    setup({ 'GET /api/device': () => jsonResponse({ error: 'device store offline' }, 500) });

    renderWithProviders(<Device permissions={['device.read']} />);

    expect(await screen.findByText('device store offline')).toBeInTheDocument();
  });

  it('POSTs only the changed fields to /api/device/transition', async () => {
    let captured: Record<string, unknown> | undefined;
    const updated = deviceFixture({ battery: 10, network: 'offline' });
    setup({
      'GET /api/device': { device: deviceFixture() },
      'POST /api/device/transition': (init?: RequestInit) => {
        captured = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return jsonResponse({ device: updated });
      },
    });

    renderWithProviders(<Device permissions={['device.write']} />);

    // Order of controls: spinbutton[0] = battery, spinbutton[1] = notifications;
    // combobox[0] = network, [1] = screen, [2] = activity.
    const battery = (await screen.findAllByRole('spinbutton'))[0];
    expect(battery).toBeDefined();
    fireEvent.change(battery!, { target: { value: '10' } });

    const network = screen.getAllByRole('combobox')[0];
    fireEvent.change(network!, { target: { value: 'offline' } });

    const apply = screen.getByRole('button', { name: '应用变更' });
    expect(apply).toBeEnabled();
    fireEvent.click(apply);

    await waitFor(() => expect(captured).toBeDefined());
    expect(captured).toEqual({ battery: 10, network: 'offline' });

    const fetched = vi.mocked(fetch).mock.calls.map((call) => String(call[0]));
    expect(fetched).toContain('/api/device/transition');

    // The server response replaces the rendered state.
    expect(await screen.findByText('已应用 2 项变更。')).toBeInTheDocument();
  });

  it('hides the transition form when device.write is missing', async () => {
    setup({ 'GET /api/device': { device: deviceFixture() } });

    renderWithProviders(<Device permissions={['device.read']} />);

    expect(await screen.findByText('当前状态')).toBeInTheDocument();
    expect(screen.getByText(/缺少 device.write 权限/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '应用变更' })).not.toBeInTheDocument();
  });
});
