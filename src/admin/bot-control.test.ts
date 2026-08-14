import { describe, expect, it, vi } from 'vitest';
import type { BotSnapshot } from '../bot/runtime.js';
import { BotControlError, BotControlFacade } from './bot-control.js';

function snapshot(overrides: Partial<BotSnapshot> = {}): BotSnapshot {
  return {
    id: 'main', name: 'Main', running: true, adapter: 'discord', model: 'secret-model', provider: 'secret-provider',
    gateway: { connected: true, ping: 12, username: 'bot', guilds: 2, reconnects: 1, lastError: 'token=secret-value' },
    sessions: 3, plugins: [{ id: 'demo', state: 'loaded', errors: 0 }],
    pipeline: { handled: 4, replied: 3, skipped: 1, aiFailures: 0, rateLimited: 0 },
    modelHealth: { generatedAt: 1, profiles: [], models: { reply: { availability: 'available', checkedAt: 1 } } }, ...overrides,
  };
}

describe('BotControlFacade', () => {
  it('returns allowlisted detached views without provider, model or gateway errors', () => {
    const source = snapshot();
    const facade = new BotControlFacade({ snapshots: () => [source], restart: async () => true, reloadPlugin: async () => true });
    const view = facade.get('main');
    expect(JSON.stringify(view)).not.toMatch(/secret-model|secret-provider|secret-value|lastError|sessions|pipeline/);
    expect(view).toMatchObject({ id: 'main', gateway: { connected: true }, plugins: [{ id: 'demo' }] });
    source.gateway.username = 'changed';
    expect(view.gateway.username).toBe('bot');
  });

  it('serializes all writes for one bot but allows different bots', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const restart = vi.fn(async () => { await pending; return true; });
    const facade = new BotControlFacade({ snapshots: () => [snapshot(), snapshot({ id: 'other' })], restart, reloadPlugin: async () => true });
    const first = facade.restart('main');
    await expect(facade.reloadPlugin('main', 'demo')).rejects.toMatchObject({ code: 'busy' });
    const other = facade.restart('other');
    release();
    await expect(first).resolves.toMatchObject({ id: 'main' });
    await expect(other).resolves.toMatchObject({ id: 'other' });
  });

  it('distinguishes missing bot, plugin and failed actions', async () => {
    const facade = new BotControlFacade({ snapshots: () => [snapshot()], restart: async () => false, reloadPlugin: async () => false });
    expect(() => facade.get('missing')).toThrow(BotControlError);
    await expect(facade.reloadPlugin('main', 'missing')).rejects.toMatchObject({ code: 'plugin_not_found' });
    await expect(facade.restart('main')).rejects.toMatchObject({ code: 'restart_failed' });
    await expect(facade.reloadPlugin('main', 'demo')).rejects.toMatchObject({ code: 'plugin_reload_failed' });
    const throwing = new BotControlFacade({ snapshots: () => [snapshot()], restart: async () => { throw new Error('supervisor token=secret'); }, reloadPlugin: async () => { throw new Error('plugin secret'); } });
    await expect(throwing.restart('main')).rejects.toMatchObject({ code: 'restart_failed', message: 'restart_failed' });
    await expect(throwing.reloadPlugin('main', 'demo')).rejects.toMatchObject({ code: 'plugin_reload_failed', message: 'plugin_reload_failed' });
  });
});
