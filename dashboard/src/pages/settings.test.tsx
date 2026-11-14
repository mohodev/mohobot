import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../test/render';
import { mockFetch, jsonResponse } from '../test/fixtures';
import { setSessionToken } from '../lib/api';
import { Settings } from './settings';

const PUBLICATION = {
  snapshot: {
    state: { scope: 'global', stateVersion: 3, phase: 'active', activeRevision: 4, desiredRevision: 4, previousActiveRevision: 2 },
    active: { scope: 'global', revision: 4, digest: 'abcdef0123456789', publishedAt: 1_700_000_000_000, publishedBy: 'admin-1' },
    acknowledgements: [],
  },
  history: [{ revision: 4, digest: 'abcdef0123456789', publishedBy: 'admin-1', publishedAt: 1_700_000_000_000 }],
  transitions: [{ id: 1, revision: 4, kind: 'activated', actor: 'admin-1', at: 1_700_000_000_000, detail: 'legacy immediate activation' }],
  effective: { scope: 'global', activeRevision: 4, effective: true },
};

const RECEIPTS = {
  receipts: {
    items: [{ scope: 'global', revision: 4, digest: 'abcdef0123456789', actor: 'runtime-boot', activatedAt: 1_700_000_000_000, detail: 'runtime boot activation' }],
    effective: { scope: 'global', activeRevision: 4, effective: true },
  },
};

function setup(routes: Parameters<typeof mockFetch>[0]) {
  const fetchMock = mockFetch(routes);
  vi.stubGlobal('fetch', fetchMock);
  setSessionToken('test-token');
  return fetchMock;
}

function baseRoutes(overrides: Parameters<typeof mockFetch>[0] = {}) {
  return {
    'GET /api/config/publication': { publication: PUBLICATION },
    'GET /api/config/activation-receipts': RECEIPTS,
    ...overrides,
  };
}

beforeEach(() => {
  setSessionToken('test-token');
});

afterEach(() => {
  cleanup();
  setSessionToken('');
  vi.unstubAllGlobals();
});

describe('Settings (config publication)', () => {
  it('renders the publication revision, status and publisher', async () => {
    setup(baseRoutes());

    renderWithProviders(<Settings permissions={['config.publish']} />);

    expect(await screen.findByText('当前修订')).toBeInTheDocument();
    expect(screen.getAllByText('4').length).toBeGreaterThan(0);
    expect(screen.getAllByText('已生效').length).toBeGreaterThan(0);
    expect(screen.getAllByText('admin-1').length).toBeGreaterThan(0);
    expect(await screen.findByText('runtime-boot')).toBeInTheDocument();
  });

  it('shows the empty state when there is no publication', async () => {
    setup(baseRoutes({ 'GET /api/config/publication': { publication: null } }));

    renderWithProviders(<Settings permissions={['config.publish']} />);

    expect(await screen.findByText('尚无发布记录')).toBeInTheDocument();
  });

  it('shows an error state when the publication load fails', async () => {
    setup(baseRoutes({ 'GET /api/config/publication': () => jsonResponse({ error: 'boom' }, 500) }));

    renderWithProviders(<Settings permissions={['config.publish']} />);

    expect(await screen.findByText('boom')).toBeInTheDocument();
  });

  it('runs the confirmation flow and posts the parsed publish payload', async () => {
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('确认');
    const fetchMock = setup(
      baseRoutes({
        'POST /api/confirmations': { confirmation: { nonce: 'nonce-1' } },
        'POST /api/config/publish': { publication: { revision: 5, status: 'active' } },
      }),
    );

    renderWithProviders(<Settings permissions={['config.publish']} />);

    const textarea = await screen.findByLabelText(/变更载荷/);
    fireEvent.change(textarea, { target: { value: '{"expectedRevision":4,"payload":{"feature":true}}' } });
    fireEvent.click(screen.getByRole('button', { name: /发布配置/ }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input]) => String(input).includes('/api/config/publish'));
      expect(call).toBeTruthy();
    });
    expect(prompt).toHaveBeenCalledTimes(1);

    const call = fetchMock.mock.calls.find(([input]) => String(input).includes('/api/config/publish'));
    const init = call?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ expectedRevision: 4, payload: { feature: true } });
  });

  it('hides mutating controls without the config.publish permission', async () => {
    setup(baseRoutes());

    renderWithProviders(<Settings permissions={[]} />);

    expect(await screen.findByText(/只读：当前账号缺少 config.publish 权限/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /发布配置/ })).toBeNull();
  });
});
