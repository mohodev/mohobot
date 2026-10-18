import { describe, expect, it, vi } from 'vitest';
import { MessagePlanner } from './message-planner.js';
import type { MohoMessage } from '../core/types.js';
import type { AIProvider } from '../ai/types.js';
import type { Logger } from '../core/logger.js';

const noop = () => {};
const noopLogger: Logger = {
  trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop,
  child: () => noopLogger,
} as any;

const msg = (content: string, overrides: Partial<MohoMessage> = {}): MohoMessage => ({
  id: 'm1', platform: 'discord', botId: 'b', channel: { id: 'c', dm: false },
  author: { id: 'u', username: 'user', bot: false }, content, mentionsBot: false,
  attachments: [], createdAt: 0, ...overrides,
});

const ctx = { channelName: 'general', recentMessages: ['user1: hello', 'user2: 你好'] };

function fakeProvider(content: string, delay = 0): AIProvider {
  return {
    name: 'fake', model: 'fake-model',
    chat: vi.fn(async () => {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      return { content, model: 'fake-model', ms: 10 };
    }),
    health: async () => ({ ok: true }),
  };
}

describe('MessagePlanner', () => {
  it('returns reply when the LLM says reply', async () => {
    const provider = fakeProvider('{"action":"reply","reason":"has a question"}');
    const planner = new MessagePlanner(provider, { enabled: true }, noopLogger);
    const result = await planner.plan(msg('这个功能怎么用？'), ctx, 5000);
    expect(result.action).toBe('reply');
    expect(result.reason).toBe('has a question');
  });

  it('returns ignore when the LLM says ignore', async () => {
    const provider = fakeProvider('{"action":"ignore","reason":"pure emoji spam"}');
    const planner = new MessagePlanner(provider, { enabled: true }, noopLogger);
    const result = await planner.plan(msg('😂😂😂'), ctx, 5000);
    expect(result.action).toBe('ignore');
    expect(result.reason).toBe('pure emoji spam');
  });

  it('falls back to reply on timeout/error', async () => {
    const provider: AIProvider = {
      name: 'fake', model: 'fake-model',
      chat: vi.fn(async () => { throw new Error('timeout'); }),
      health: async () => ({ ok: true }),
    };
    const planner = new MessagePlanner(provider, { enabled: true }, noopLogger);
    const result = await planner.plan(msg('test'), ctx, 5000);
    expect(result.action).toBe('reply');
    expect(result.reason).toBe('planner error fallback');
  });

  it('falls back to reply on unparseable output', async () => {
    const provider = fakeProvider('I think we should reply because...');
    const planner = new MessagePlanner(provider, { enabled: true }, noopLogger);
    const result = await planner.plan(msg('test'), ctx, 5000);
    expect(result.action).toBe('reply');
    expect(result.reason).toBe('unparseable planner output');
  });

  it('always replies to direct summons (DM)', async () => {
    const provider = fakeProvider('{"action":"ignore","reason":"not relevant"}');
    const planner = new MessagePlanner(provider, { enabled: true }, noopLogger);
    const result = await planner.plan(msg('hi', { channel: { id: 'c', dm: true } }), ctx, 5000);
    expect(result.action).toBe('reply');
    expect(result.reason).toBe('direct summon bypasses planner');
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it('always replies to @mentions', async () => {
    const provider = fakeProvider('{"action":"ignore","reason":"not relevant"}');
    const planner = new MessagePlanner(provider, { enabled: true }, noopLogger);
    const result = await planner.plan(msg('hi', { mentionsBot: true }), ctx, 5000);
    expect(result.action).toBe('reply');
    expect(result.reason).toBe('direct summon bypasses planner');
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it('always replies for admin/bot manager', async () => {
    const provider = fakeProvider('{"action":"ignore","reason":"not relevant"}');
    const planner = new MessagePlanner(provider, { enabled: true }, noopLogger);
    const result = await planner.plan(msg('?status', { author: { id: 'admin', username: 'admin', bot: false, isBotManager: true } }), ctx, 5000);
    expect(result.action).toBe('reply');
    expect(result.reason).toBe('admin bypasses planner');
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it('passes through as reply when disabled', async () => {
    const provider = fakeProvider('{"action":"ignore","reason":"not relevant"}');
    const planner = new MessagePlanner(provider, { enabled: false }, noopLogger);
    const result = await planner.plan(msg('test'), ctx, 5000);
    expect(result.action).toBe('reply');
    expect(result.reason).toBe('planner disabled');
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it('uses the configured model override', async () => {
    const provider = fakeProvider('{"action":"reply","reason":"ok"}');
    const planner = new MessagePlanner(provider, { enabled: true, model: 'custom-model' }, noopLogger);
    await planner.plan(msg('test'), ctx, 5000);
    expect(provider.chat).toHaveBeenCalledTimes(1);
    const opts = (provider.chat as any).mock.calls[0][1];
    expect(opts.model).toBe('custom-model');
  });

  it('uses task=planner for the chat call', async () => {
    const provider = fakeProvider('{"action":"reply","reason":"ok"}');
    const planner = new MessagePlanner(provider, { enabled: true }, noopLogger);
    await planner.plan(msg('test'), ctx, 5000);
    const opts = (provider.chat as any).mock.calls[0][1];
    expect(opts.task).toBe('planner');
  });

  it('parses JSON with reversed key order', async () => {
    const provider = fakeProvider('{"reason":"emoji flood","action":"ignore"}');
    const planner = new MessagePlanner(provider, { enabled: true }, noopLogger);
    const result = await planner.plan(msg('😂'), ctx, 5000);
    expect(result.action).toBe('ignore');
    expect(result.reason).toBe('emoji flood');
  });
});
