import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithProviders } from '../test/render';
import { jsonResponse, mockFetch } from '../test/fixtures';
import { setSessionToken } from '../lib/api';
import type { CharacterRecord } from '../lib/types';
import { Characters } from './characters';

const REVISION = 'a'.repeat(64);

function characterFixture(overrides: Partial<CharacterRecord> = {}): CharacterRecord {
  return {
    id: 'mika',
    name: 'Mika',
    promptLength: 42,
    tags: ['companion'],
    enabled: true,
    revision: REVISION,
    updatedAt: '2026-01-02T03:04:05.000Z',
    ...overrides,
  };
}

const FULL_PROMPT = '# Mika\n\n你是一位温柔的伙伴，请保持自然亲切的对话风格。';
const NEW_PROMPT = '# 新角色\n\n这是一个全新的角色设定，用于测试保存流程。';

function setup(routes: Parameters<typeof mockFetch>[0]) {
  const fetchMock = mockFetch(routes);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('prompt', vi.fn(() => '确认'));
  setSessionToken('test-token');
  return fetchMock;
}

/** Returns the parsed JSON body of the first matching method+path request. */
function requestBody(
  fetchMock: ReturnType<typeof setup>,
  method: string,
  path: string,
): Record<string, unknown> | undefined {
  for (const call of fetchMock.mock.calls) {
    const input = call[0];
    const init = call[1];
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const resolved = new URL(url, 'http://localhost');
    if ((init?.method ?? 'GET').toUpperCase() !== method) continue;
    if (resolved.pathname !== path) continue;
    if (typeof init?.body !== 'string') return {};
    return JSON.parse(init.body) as Record<string, unknown>;
  }
  return undefined;
}

beforeEach(() => {
  setSessionToken('test-token');
});

afterEach(() => {
  setSessionToken('');
  vi.unstubAllGlobals();
});

describe('Characters', () => {
  it('renders character rows from the catalog response', async () => {
    setup({
      'GET /api/characters': {
        characters: [
          characterFixture(),
          characterFixture({ id: 'ren', name: 'Ren', promptLength: 128, tags: [], enabled: false }),
        ],
      },
    });

    renderWithProviders(<Characters permissions={['characters.read']} />);

    expect(await screen.findByText('Mika')).toBeInTheDocument();
    expect(screen.getByText('Ren')).toBeInTheDocument();
    expect(screen.getByText('128')).toBeInTheDocument();
    expect(screen.getByText('已停用')).toBeInTheDocument();
    expect(screen.getByText('2 个角色')).toBeInTheDocument();
  });

  it('shows the empty state when the catalog is empty', async () => {
    setup({ 'GET /api/characters': { characters: [] } });

    renderWithProviders(<Characters permissions={['characters.read']} />);

    expect(await screen.findByText('还没有角色档案')).toBeInTheDocument();
  });

  it('shows an error state when the catalog request fails', async () => {
    setup({
      'GET /api/characters': () => jsonResponse({ error: '角色目录不可用' }, 500),
    });

    renderWithProviders(<Characters permissions={['characters.read']} />);

    expect(await screen.findByText('角色目录不可用')).toBeInTheDocument();
  });

  it('runs the confirmation flow and POSTs a new character', async () => {
    const fetchMock = setup({
      'GET /api/characters': { characters: [] },
      'POST /api/confirmations': { confirmation: { nonce: 'nonce-1' } },
      'POST /api/characters': { character: characterFixture({ id: 'newbie', name: '新角色', promptLength: 30 }) },
    });

    renderWithProviders(<Characters permissions={['characters.write']} />);
    await screen.findByText('还没有角色档案');

    fireEvent.click(screen.getByRole('button', { name: /新建角色/ }));
    fireEvent.change(screen.getByLabelText('角色名称'), { target: { value: '新角色' } });
    fireEvent.change(screen.getByLabelText('角色提示词'), { target: { value: NEW_PROMPT } });
    fireEvent.click(screen.getByRole('button', { name: /保存/ }));

    await waitFor(() => expect(requestBody(fetchMock, 'POST', '/api/characters')).toBeDefined());
    expect(window.prompt).toHaveBeenCalled();
    const posted = requestBody(fetchMock, 'POST', '/api/characters');
    expect(posted?.name).toBe('新角色');
    expect(posted).not.toHaveProperty('expectedRevision');
  });

  it('requires and sends the 64-hex expectedRevision when updating', async () => {
    const fetchMock = setup({
      'GET /api/characters': { characters: [characterFixture()] },
      'GET /api/characters/mika': { character: { ...characterFixture(), prompt: FULL_PROMPT } },
      'POST /api/confirmations': { confirmation: { nonce: 'nonce-2' } },
      'PUT /api/characters/mika': { character: characterFixture() },
    });

    renderWithProviders(<Characters permissions={['characters.write']} />);
    await screen.findByText('Mika');

    const row = screen.getByText('Mika').closest('tr');
    expect(row).not.toBeNull();
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: /编辑/ }));

    const promptBox = await screen.findByLabelText('角色提示词');
    await waitFor(() => expect(promptBox).toHaveValue(FULL_PROMPT));

    fireEvent.click(screen.getByRole('button', { name: /保存/ }));

    await waitFor(() => expect(requestBody(fetchMock, 'PUT', '/api/characters/mika')).toBeDefined());
    const put = requestBody(fetchMock, 'PUT', '/api/characters/mika');
    expect(put?.expectedRevision).toBe(REVISION);
    expect(put?.name).toBe('Mika');
  });

  it('blocks the save when the loaded revision is not 64-hex', async () => {
    const fetchMock = setup({
      'GET /api/characters': { characters: [characterFixture()] },
      'GET /api/characters/mika': { character: { ...characterFixture(), revision: 'stale', prompt: FULL_PROMPT } },
    });

    renderWithProviders(<Characters permissions={['characters.write']} />);
    await screen.findByText('Mika');

    const row = screen.getByText('Mika').closest('tr');
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: /编辑/ }));
    const promptBox = await screen.findByLabelText('角色提示词');
    await waitFor(() => expect(promptBox).toHaveValue(FULL_PROMPT));

    fireEvent.click(screen.getByRole('button', { name: /保存/ }));

    expect(await screen.findByText(/缺少有效的角色 revision/)).toBeInTheDocument();
    expect(requestBody(fetchMock, 'PUT', '/api/characters/mika')).toBeUndefined();
  });
});
