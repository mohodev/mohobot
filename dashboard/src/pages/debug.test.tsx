import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../test/render';
import { mockFetch, jsonResponse, botFixture } from '../test/fixtures';
import { setSessionToken } from '../lib/api';
import { Debug } from './debug';

const CAPABILITIES = {
  bots: [
    { id: 'moho', model: 'gpt-4o-mini', available: true },
    { id: 'spare', model: 'unavailable', available: false },
  ],
  limits: { maxInputChars: 4000, timeoutMs: 15000, requestsPerMinute: 6 },
};

function reply(content: string) {
  return {
    trace: {
      id: 'dbg_1',
      at: Date.now(),
      actorId: 'admin',
      botId: 'moho',
      model: 'gpt-4o-mini',
      latencyMs: 42,
      outcome: 'ok' as const,
      fallback: false,
    },
    content,
  };
}

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

describe('Debug', () => {
  it('renders the debug capabilities snapshot', async () => {
    setup({
      'GET /api/debug/chat/capabilities': { capabilities: CAPABILITIES },
      'GET /api/bots': { bots: [botFixture()] },
    });

    renderWithProviders(<Debug permissions={['debug.chat', 'behavior.dry-run']} />);

    fireEvent.click(await screen.findByRole('tab', { name: /能力/ }));

    expect(await screen.findByText('gpt-4o-mini')).toBeInTheDocument();
    expect(screen.getByText('4,000')).toBeInTheDocument();
    expect(screen.getByText('15.0 s')).toBeInTheDocument();
  });

  it('posts a chat message and appends the reply to the transcript', async () => {
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    setup({
      'GET /api/debug/chat/capabilities': { capabilities: CAPABILITIES },
      'GET /api/bots': { bots: [botFixture()] },
      'POST /api/debug/chat': (init?: RequestInit) => {
        calls.push({ url: '/api/debug/chat', method: init?.method, body: String(init?.body ?? '') });
        return jsonResponse({ reply: reply('这是调试回复。') });
      },
    });

    renderWithProviders(<Debug permissions={['debug.chat']} />);

    // Bot list settles and the select defaults to the first option.
    await waitFor(() => expect(screen.getByRole('option', { name: /MohoBot/ })).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('输入用于隔离调试的消息内容'), { target: { value: '你好，调试一下' } });
    fireEvent.click(screen.getByRole('button', { name: /发送/ }));

    expect(await screen.findByText('这是调试回复。')).toBeInTheDocument();
    expect(screen.getByText('你好，调试一下')).toBeInTheDocument();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ botId: 'moho', content: '你好，调试一下', task: 'admin' });
  });

  it('does not post when the composer is empty', async () => {
    const calls: string[] = [];
    setup({
      'GET /api/debug/chat/capabilities': { capabilities: CAPABILITIES },
      'GET /api/bots': { bots: [botFixture()] },
      'POST /api/debug/chat': () => {
        calls.push('posted');
        return jsonResponse({ reply: reply('不应发生') });
      },
    });

    renderWithProviders(<Debug permissions={['debug.chat']} />);

    await waitFor(() => expect(screen.getByRole('option', { name: /MohoBot/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /发送/ }));

    expect(await screen.findByText(/尚无调试消息/)).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('shows an inline error when the debug chat request fails with 500', async () => {
    setup({
      'GET /api/debug/chat/capabilities': { capabilities: CAPABILITIES },
      'GET /api/bots': { bots: [botFixture()] },
      'POST /api/debug/chat': () => jsonResponse({ error: 'provider_failed' }, 500),
    });

    renderWithProviders(<Debug permissions={['debug.chat']} />);

    await waitFor(() => expect(screen.getByRole('option', { name: /MohoBot/ })).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('输入用于隔离调试的消息内容'), { target: { value: '触发失败' } });
    fireEvent.click(screen.getByRole('button', { name: /发送/ }));

    expect(await screen.findByText('provider_failed')).toBeInTheDocument();
  });

  it('shows the error state when capabilities return 500', async () => {
    setup({
      'GET /api/debug/chat/capabilities': () => jsonResponse({ error: 'boom' }, 500),
      'GET /api/bots': { bots: [] },
    });

    renderWithProviders(<Debug permissions={['debug.chat']} />);

    expect(await screen.findByText('boom')).toBeInTheDocument();
  });

  it('shows the empty state when no debug bots are available', async () => {
    setup({
      'GET /api/debug/chat/capabilities': { capabilities: { bots: [], limits: { maxInputChars: 0, timeoutMs: 0, requestsPerMinute: 0 } } },
      'GET /api/bots': { bots: [] },
    });

    renderWithProviders(<Debug permissions={['debug.chat']} />);

    fireEvent.click(await screen.findByRole('tab', { name: /能力/ }));
    expect(await screen.findByText('没有可用的调试模型')).toBeInTheDocument();
  });

  it('posts the behavior dry-run and renders the decision result', async () => {
    const calls: Array<Record<string, unknown>> = [];
    setup({
      'GET /api/debug/chat/capabilities': { capabilities: CAPABILITIES },
      'GET /api/bots': { bots: [botFixture()] },
      'POST /api/behavior/dry-run': (init?: RequestInit) => {
        calls.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return jsonResponse({
          result: {
            decision: { action: 'reply', urgency: 'normal', reason: 'direct' },
            inputs: { energy: 0.65, stress: 0.2, deviceDelay: false, affinity: 0.4, recentReplies: 0, dm: true, mentionsBot: false },
          },
        });
      },
    });

    renderWithProviders(<Debug permissions={['behavior.dry-run']} />);

    fireEvent.click(await screen.findByRole('tab', { name: /行为 Dry-run/ }));
    await waitFor(() => expect(screen.getByRole('option', { name: /MohoBot/ })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /运行 Dry-run/ }));

    expect(await screen.findByText('direct')).toBeInTheDocument();
    expect(screen.getByText('回复')).toBeInTheDocument();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      botId: 'moho',
      channelId: 'dm:debug-user',
      userId: 'debug-user',
      dm: true,
      mentionsBot: false,
      recentReplies: 0,
    });
  });
});
