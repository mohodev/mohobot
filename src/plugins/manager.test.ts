import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../core/event.js';
import { createNullLogger } from '../core/logger.js';
import { createRegistries } from '../core/registries.js';
import {
  AIConfigSchema,
  BotConfigSchema,
  MemoryConfigSchema,
  SessionConfigSchema,
  type ResolvedBotConfig,
} from '../config/schema.js';
import type { MohoMessage, OutboundMessage } from '../core/types.js';
import { PluginManager } from './manager.js';

let dir: string;
const sent: OutboundMessage[] = [];

function makeMessage(content: string): MohoMessage {
  return {
    id: 'm1',
    platform: 'console',
    botId: 'main',
    channel: { id: 'c1', dm: true },
    author: { id: 'u1', username: 'tester', bot: false },
    content,
    mentionsBot: true,
    attachments: [],
    createdAt: Date.now(),
  };
}

async function writePlugin(id: string, source: string, manifest?: Record<string, unknown>): Promise<void> {
  const pdir = path.join(dir, id);
  await fs.mkdir(pdir, { recursive: true });
  await fs.writeFile(path.join(pdir, 'index.ts'), source, 'utf8');
  if (manifest) {
    await fs.writeFile(path.join(pdir, 'plugin.json'), JSON.stringify(manifest), 'utf8');
  }
}

function makeBotConfig(): ResolvedBotConfig {
  const base = BotConfigSchema.parse({ id: 'main' });
  return {
    ...base,
    ai: AIConfigSchema.parse(base.ai),
    session: SessionConfigSchema.parse(base.session),
    memory: MemoryConfigSchema.parse(base.memory),
  };
}

function makeManager(overrides: Partial<ConstructorParameters<typeof PluginManager>[0]> = {}) {
  return new PluginManager({
    dir,
    logger: createNullLogger(),
    events: new EventBus(),
    hookTimeoutMs: 200,
    maxErrors: 2,
    allow: [],
    deny: [],
    send: async (out) => void sent.push(out),
    botConfig: makeBotConfig(),
    registries: createRegistries(),
    ...overrides,
  });
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moho-plugins-'));
  sent.length = 0;
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('PluginManager', () => {
  it('loads a plugin and registers its commands', async () => {
    await writePlugin(
      'hello',
      `export default {
         name: 'hello',
         onLoad(ctx) { ctx.registerCommand({ name: 'hi', execute: () => 'hello there' }); },
       };`,
      { name: 'hello', version: '1.0.0' },
    );
    const pm = makeManager();
    await pm.loadAll();

    expect(pm.list()).toHaveLength(1);
    expect(pm.list()[0]?.state).toBe('loaded');
    expect([...pm.commands().keys()]).toContain('hi');
  });

  it('works without a plugin.json manifest', async () => {
    await writePlugin('bare', `export default { name: 'bare' };`);
    const pm = makeManager();
    await pm.loadAll();
    expect(pm.list()[0]?.manifest.version).toBe('0.0.0');
  });

  it('accepts a factory default export', async () => {
    await writePlugin('factory', `export default () => ({ name: 'factory' });`);
    const pm = makeManager();
    await pm.loadAll();
    expect(pm.list()[0]?.state).toBe('loaded');
  });

  it('survives a plugin that throws during onLoad', async () => {
    await writePlugin('good', `export default { name: 'good' };`);
    await writePlugin('bad', `export default { name: 'bad', onLoad() { throw new Error('load boom'); } };`);
    const pm = makeManager();
    await pm.loadAll();

    const ids = pm.list().map((p) => p.id);
    expect(ids).toContain('good');
    expect(ids).not.toContain('bad');
  });

  it('reaps staged registry entries when onLoad fails', async () => {
    await writePlugin(
      'leaky',
      `export default {
         name: 'leaky',
         onLoad(ctx) {
           ctx.registry.providers.register('leaked-provider', () => ({}));
           throw new Error('after register');
         },
       };`,
    );
    const registries = createRegistries();
    const pm = makeManager({ registries });

    await expect(pm.load('leaky')).resolves.toBe(false);
    expect(registries.providers.has('leaked-provider')).toBe(false);
  });

  it('survives a plugin with a syntax error', async () => {
    await writePlugin('broken', `export default { name: 'broken', ;;; }`);
    await writePlugin('ok', `export default { name: 'ok' };`);
    const pm = makeManager();
    await pm.loadAll();
    expect(pm.list().map((p) => p.id)).toEqual(['ok']);
  });

  it('isolates an onMessage failure and keeps other plugins running', async () => {
    await writePlugin('explode', `export default { name: 'explode', onMessage() { throw new Error('hook boom'); } };`);
    await writePlugin(
      'tag',
      `export default { name: 'tag', onMessage(m) { return { content: m.content + ' [tagged]' }; } };`,
      { name: 'tag', version: '1.0.0', priority: 200 },
    );
    const pm = makeManager();
    await pm.loadAll();

    const result = await pm.runMessageHooks(makeMessage('hi'));
    expect(result.content).toBe('hi [tagged]');
    const explode = pm.list().find((p) => p.id === 'explode');
    expect(explode?.errors).toBe(1);
  });

  it('disables a plugin after maxErrors consecutive failures', async () => {
    await writePlugin('flaky', `export default { name: 'flaky', onMessage() { throw new Error('again'); } };`);
    const pm = makeManager();
    await pm.loadAll();

    await pm.runMessageHooks(makeMessage('1'));
    await pm.runMessageHooks(makeMessage('2'));

    expect(pm.list()[0]?.state).toBe('disabled');
  });

  it('times out a hanging hook instead of blocking forever', async () => {
    await writePlugin(
      'hang',
      `export default { name: 'hang', async onMessage() { await new Promise(() => {}); } };`,
    );
    const pm = makeManager({ hookTimeoutMs: 50 });
    await pm.loadAll();

    const started = Date.now();
    await pm.runMessageHooks(makeMessage('x'));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(pm.list()[0]?.lastError).toContain('timed out');
  });

  it('honours stop: true and short-circuits the chain', async () => {
    await writePlugin(
      'stopper',
      `export default { name: 'stopper', onMessage() { return { stop: true, reply: 'halted' }; } };`,
      { name: 'stopper', version: '1.0.0', priority: 1 },
    );
    await writePlugin(
      'later',
      `export default { name: 'later', onMessage() { return { content: 'should not run' }; } };`,
      { name: 'later', version: '1.0.0', priority: 500 },
    );
    const pm = makeManager();
    await pm.loadAll();

    const result = await pm.runMessageHooks(makeMessage('x'));
    expect(result.stop).toBe(true);
    expect(result.reply).toBe('halted');
    expect(result.content).toBeUndefined();
  });

  // NOTE: vitest's module runner caches by path and ignores our `?v=<ts>` cache
  // buster, so re-importing the SAME file cannot be tested here. Reload is
  // therefore exercised via a changed manifest entry (a different module URL),
  // and true same-file hot reload is verified under the real runtime by
  // scripts/verify-hotreload.ts.
  it('hot reloads a plugin when its entry module changes', async () => {
    await writePlugin('ver', `export default { name: 'ver', onMessage() { return { reply: 'v1' }; } };`, {
      name: 'ver',
      version: '1.0.0',
      main: 'index.ts',
    });
    const pm = makeManager();
    await pm.loadAll();
    expect((await pm.runMessageHooks(makeMessage('x'))).reply).toBe('v1');

    await fs.writeFile(
      path.join(dir, 'ver', 'v2.ts'),
      `export default { name: 'ver', onMessage() { return { reply: 'v2' }; } };`,
      'utf8',
    );
    await fs.writeFile(
      path.join(dir, 'ver', 'plugin.json'),
      JSON.stringify({ name: 'ver', version: '2.0.0', main: 'v2.ts' }),
      'utf8',
    );

    expect(await pm.load('ver')).toBe(true);
    expect((await pm.runMessageHooks(makeMessage('x'))).reply).toBe('v2');
    expect(pm.list()[0]?.manifest.version).toBe('2.0.0');
  });

  it('keeps the old version when a reload fails', async () => {
    await writePlugin('keep', `export default { name: 'keep', onMessage() { return { reply: 'good' }; } };`, {
      name: 'keep',
      version: '1.0.0',
      main: 'index.ts',
    });
    const pm = makeManager();
    await pm.loadAll();

    // Point the manifest at a module that blows up on import.
    await fs.writeFile(path.join(dir, 'keep', 'broken.ts'), `throw new Error('import boom');`, 'utf8');
    await fs.writeFile(
      path.join(dir, 'keep', 'plugin.json'),
      JSON.stringify({ name: 'keep', version: '2.0.0', main: 'broken.ts' }),
      'utf8',
    );

    expect(await pm.load('keep')).toBe(false);
    // The previously loaded instance is still serving traffic.
    expect((await pm.runMessageHooks(makeMessage('x'))).reply).toBe('good');
    expect(pm.list()[0]?.manifest.version).toBe('1.0.0');
  });

  it('keeps the old version when the new entry file is missing', async () => {
    await writePlugin('missing', `export default { name: 'missing', onMessage() { return { reply: 'alive' }; } };`);
    const pm = makeManager();
    await pm.loadAll();

    await fs.writeFile(
      path.join(dir, 'missing', 'plugin.json'),
      JSON.stringify({ name: 'missing', version: '2.0.0', main: 'nope.ts' }),
      'utf8',
    );

    expect(await pm.load('missing')).toBe(false);
    expect((await pm.runMessageHooks(makeMessage('x'))).reply).toBe('alive');
  });

  it('rejects plugin ids that escape the configured plugin directory', async () => {
    const pm = makeManager();

    await expect(pm.load('../outside')).resolves.toBe(false);
    await expect(pm.load('..')).resolves.toBe(false);
    await expect(pm.load('')).resolves.toBe(false);
    expect(pm.list()).toHaveLength(0);
  });

  it('rejects manifest entry files that escape the plugin directory', async () => {
    await writePlugin('escape', `export default { name: 'escape' };`, {
      name: 'escape',
      main: '../outside.ts',
    });
    await fs.writeFile(path.join(dir, 'outside.ts'), `export default { name: 'outside' };`, 'utf8');

    const pm = makeManager();
    await expect(pm.load('escape')).resolves.toBe(false);
    expect(pm.list()).toHaveLength(0);
  });

  it('passes manifest config into a frozen plugin context', async () => {
    await writePlugin(
      'configured',
      `export default {
         name: 'configured',
         onLoad(ctx) {
           ctx.registerCommand({ name: 'setting', execute: () => String(ctx.config.answer) + ':' + Object.isFrozen(ctx.config) });
         },
       };`,
      { name: 'configured', config: { answer: 42 } },
    );

    const pm = makeManager();
    await pm.loadAll();
    const result = await pm.executeCommand('setting', {
      message: makeMessage('!setting'),
      args: [],
      raw: '!setting',
      reply: async () => {},
    });
    expect(result).toBe('42:true');
  });

  it('respects allow and deny lists', async () => {
    await writePlugin('yes', `export default { name: 'yes' };`);
    await writePlugin('no', `export default { name: 'no' };`);

    const denied = makeManager({ deny: ['no'] });
    await denied.loadAll();
    expect(denied.list().map((p) => p.id)).toEqual(['yes']);

    const allowed = makeManager({ allow: ['no'] });
    await allowed.loadAll();
    expect(allowed.list().map((p) => p.id)).toEqual(['no']);
  });

  it('skips a plugin disabled in its manifest', async () => {
    await writePlugin('off', `export default { name: 'off' };`, { name: 'off', version: '1.0.0', enabled: false });
    const pm = makeManager();
    await pm.loadAll();
    expect(pm.list()).toHaveLength(0);
  });

  it('runs onUnload and clears commands on unload', async () => {
    await writePlugin(
      'bye',
      `export default {
         name: 'bye',
         onLoad(ctx) { ctx.registerCommand({ name: 'gone', execute: () => 'x' }); },
         onUnload() { globalThis.__byeRan = true; },
       };`,
    );
    const pm = makeManager();
    await pm.loadAll();
    await pm.unload('bye');

    expect(pm.list()).toHaveLength(0);
    expect(pm.commands().size).toBe(0);
    expect((globalThis as Record<string, unknown>).__byeRan).toBe(true);
  });

  it('contains a throwing command execution', async () => {
    await writePlugin(
      'boom',
      `export default {
         name: 'boom',
         onLoad(ctx) { ctx.registerCommand({ name: 'crash', execute: () => { throw new Error('cmd boom'); } }); },
       };`,
    );
    const pm = makeManager();
    await pm.loadAll();

    const result = await pm.executeCommand('crash', {
      message: makeMessage('!crash'),
      args: [],
      raw: '!crash',
      reply: async () => {},
    });
    expect(result).toBeUndefined();
    expect(pm.list()[0]?.errors).toBe(1);
  });

  it('handles a missing plugins directory gracefully', async () => {
    const pm = makeManager({ dir: path.join(dir, 'does-not-exist') });
    await expect(pm.loadAll()).resolves.toBeUndefined();
    expect(pm.list()).toHaveLength(0);
  });

  it('runs onAfterAI transformations in priority order', async () => {
    await writePlugin('a1', `export default { name: 'a1', onAfterAI({ reply }) { return reply + '-one'; } };`, {
      name: 'a1',
      version: '1.0.0',
      priority: 10,
    });
    await writePlugin('a2', `export default { name: 'a2', onAfterAI({ reply }) { return reply + '-two'; } };`, {
      name: 'a2',
      version: '1.0.0',
      priority: 20,
    });
    const pm = makeManager();
    await pm.loadAll();

    expect(await pm.runAfterAI(makeMessage('x'), 'base')).toBe('base-one-two');
  });
});
