import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { AIConfigSchema } from '../config/schema.js';
import { createNullLogger } from '../core/logger.js';
import { createProvider, OPENCODE_CLI_PROVIDER, registerBuiltinProviders } from './index.js';
import { AIError } from './types.js';
import { extractText, isServiceTransportError, OpenCodeCliProvider, renderPrompt } from './opencode-cli.js';

const logger = createNullLogger();

function config(overrides: Record<string, unknown> = {}) {
  return AIConfigSchema.parse({ provider: OPENCODE_CLI_PROVIDER, model: 'opencode/ling-3.1-flash-free', ...overrides });
}

/** Minimal ChildProcess stand-in driven by the test. */
function fakeChild(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: (signal?: string) => boolean; killed: string[] } {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: (signal?: string) => boolean; killed: string[] };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = [];
  child.kill = (signal?: string) => { child.killed.push(signal ?? 'SIGTERM'); return true; };
  return child;
}

function spawnSequence(children: Array<ReturnType<typeof fakeChild>>): typeof import('node:child_process').spawn {
  let index = 0;
  return vi.fn(() => {
    const child = children[index++]!;
    return child as unknown as import('node:child_process').ChildProcess;
  }) as unknown as typeof import('node:child_process').spawn;
}

function emitJson(child: ReturnType<typeof fakeChild>, events: unknown[]): void {
  for (const event of events) child.stdout.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
}

const sampleEvents = [
  { type: 'step_start', part: { type: 'step-start' } },
  { type: 'text', part: { type: 'text', text: '你好' } },
  { type: 'text', part: { type: 'text', text: '，世界！' } },
  { type: 'step_finish', part: { type: 'step-finish', reason: 'stop', tokens: { input: 100, output: 20, reasoning: 5 } } },
];

describe('opencode-cli prompt rendering', () => {
  it('renders system, user and assistant turns into one prompt', () => {
    const prompt = renderPrompt([
      { role: 'system', content: '你是洛天依' },
      { role: 'user', content: '你好', name: '小林' },
      { role: 'assistant', content: '在的' },
    ]);
    expect(prompt).toContain('<system>\n你是洛天依\n</system>');
    expect(prompt).toContain('小林: 你好');
    expect(prompt).toContain('assistant: 在的');
  });

  it('skips empty content and caps excessively long prompts from the front', () => {
    expect(renderPrompt([{ role: 'user', content: '   ' }])).toBe('');
    const long = renderPrompt([{ role: 'user', content: 'x'.repeat(120_000) }]);
    expect(long.length).toBe(100_000);
  });
});

describe('opencode-cli output parsing', () => {
  it('concatenates text parts and ignores non-text events and noise', () => {
    const stdout = [
      'not json at all',
      JSON.stringify({ type: 'step_start' }),
      JSON.stringify({ type: 'text', part: { type: 'text', text: '甲' } }),
      '{ broken',
      JSON.stringify({ type: 'text', part: { type: 'text', text: '乙' } }),
      JSON.stringify({ type: 'step_finish', part: { tokens: { input: 1, output: 2 } } }),
    ].join('\n');
    expect(extractText(stdout)).toBe('甲乙');
  });
});

describe('OpenCodeCliProvider', () => {
  it('drives the CLI and returns the assistant text with usage', async () => {
    const child = fakeChild();
    const spawn = spawnSequence([child]);
    const provider = new OpenCodeCliProvider(config(), { logger, spawnImpl: spawn });

    const promise = provider.chat([{ role: 'user', content: '你好' }]);
    emitJson(child, sampleEvents);
    child.emit('close', 0);

    const response = await promise;
    expect(response.content).toBe('你好，世界！');
    expect(response.usage).toEqual({ input: 100, output: 20, totalTokens: 120 });
    // one-shot args: run -m <model> --format json -- <prompt> (shared background service)
    const args = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string[];
    expect(args.slice(0, 4)).toEqual(['run', '-m', 'opencode/ling-3.1-flash-free', '--format']);
    expect(args).not.toContain('--standalone');
  });

  it('boots a private server per call when options.standalone is true', async () => {
    const child = fakeChild();
    const spawn = spawnSequence([child]);
    const provider = new OpenCodeCliProvider(config({ options: { standalone: true } }), { logger, spawnImpl: spawn });

    const promise = provider.chat([{ role: 'user', content: '你好' }]);
    emitJson(child, sampleEvents);
    child.emit('close', 0);
    await promise;

    const args = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string[];
    expect(args.slice(0, 5)).toEqual(['run', '--standalone', '-m', 'opencode/ling-3.1-flash-free', '--format']);
  });

  it('falls back to --standalone once when the background service is unusable', async () => {
    const broken = fakeChild();
    const isolated = fakeChild();
    const spawn = spawnSequence([broken, isolated]);
    const provider = new OpenCodeCliProvider(config(), { logger, spawnImpl: spawn });

    const promise = provider.chat([{ role: 'user', content: 'x' }]);
    broken.stderr.emit('data', Buffer.from('Error: Server process exited with code 1\nError: Managed service port 49374 on 127.0.0.1 is already in use by another process.'));
    broken.emit('close', 1);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    emitJson(isolated, sampleEvents);
    isolated.emit('close', 0);

    const response = await promise;
    expect(response.content).toBe('你好，世界！');
    const calls = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
    expect((calls[0]?.[1] as string[])).not.toContain('--standalone');
    expect((calls[1]?.[1] as string[])).toContain('--standalone');
  });

  it('does not retry model-side or timeout failures through the standalone fallback', async () => {
    const child = fakeChild();
    const spawn = spawnSequence([child]);
    const provider = new OpenCodeCliProvider(config(), { logger, spawnImpl: spawn });

    const promise = provider.chat([{ role: 'user', content: 'x' }]);
    child.stderr.emit('data', Buffer.from('provider 429 rate limited'));
    child.emit('close', 1);
    await expect(promise).rejects.toMatchObject({ name: 'AIError', kind: 'server' });
    expect(spawn).toHaveBeenCalledTimes(1);

    expect(isServiceTransportError(new AIError('opencode run timed out after 50ms', { kind: 'timeout', retryable: true }))).toBe(false);
    expect(isServiceTransportError(new AIError('request aborted by caller', { kind: 'aborted', retryable: false }))).toBe(false);
    expect(isServiceTransportError(new AIError('Error: Managed service port 49374 is already in use', { kind: 'server', retryable: true }))).toBe(true);
  });

  it('kills the child and reports a timeout', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const provider = new OpenCodeCliProvider(config({ timeoutMs: 50 }), { logger, spawnImpl: spawnSequence([child]) });
    const promise = provider.chat([{ role: 'user', content: '慢' }]);
    const assertion = expect(promise).rejects.toMatchObject({ name: 'AIError', kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
    expect(child.killed).toEqual(['SIGKILL']);
    vi.useRealTimers();
  });

  it('kills the child and reports cancellation when the signal aborts', async () => {
    const child = fakeChild();
    const provider = new OpenCodeCliProvider(config(), { logger, spawnImpl: spawnSequence([child]) });
    const controller = new AbortController();
    const promise = provider.chat([{ role: 'user', content: '取消我' }], { signal: controller.signal });
    const assertion = expect(promise).rejects.toMatchObject({ name: 'AIError', kind: 'aborted' });
    controller.abort();
    await assertion;
    expect(child.killed).toEqual(['SIGKILL']);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const provider = new OpenCodeCliProvider(config(), { logger, spawnImpl: spawnSequence([]) });
    const controller = new AbortController();
    controller.abort();
    await expect(provider.chat([{ role: 'user', content: 'x' }], { signal: controller.signal }))
      .rejects.toBeInstanceOf(AIError);
  });

  it('reports a non-zero exit with stderr and no text as an error', async () => {
    const child = fakeChild();
    const provider = new OpenCodeCliProvider(config(), { logger, spawnImpl: spawnSequence([child]) });
    const promise = provider.chat([{ role: 'user', content: 'x' }]);
    child.stderr.emit('data', Buffer.from('boom'));
    child.emit('close', 3);
    await expect(promise).rejects.toMatchObject({ name: 'AIError', kind: 'server' });
  });

  it('reports a spawn failure as a network error', async () => {
    const failing = vi.fn(() => { throw new Error('ENOENT'); }) as unknown as typeof import('node:child_process').spawn;
    const provider = new OpenCodeCliProvider(config(), { logger, spawnImpl: failing });
    await expect(provider.chat([{ role: 'user', content: 'x' }])).rejects.toMatchObject({ kind: 'network' });
  });

  it('health() reports ok on exit 0 and never throws on failure', async () => {
    const ok = fakeChild();
    const okProvider = new OpenCodeCliProvider(config(), { logger, spawnImpl: spawnSequence([ok]) });
    const okPromise = okProvider.health();
    ok.emit('close', 0);
    expect(await okPromise).toEqual({ ok: true });

    const bad = fakeChild();
    const badProvider = new OpenCodeCliProvider(config(), { logger, spawnImpl: spawnSequence([bad]) });
    const badPromise = badProvider.health();
    bad.emit('close', 1);
    expect((await badPromise).ok).toBe(false);
  });
});

describe('opencode-cli registration', () => {
  it('stays real even with an empty AI_API_KEY (credential lives in OpenCode)', () => {
    registerBuiltinProviders();
    const provider = createProvider(config({ apiKey: '' }), { logger });
    expect(provider).toBeInstanceOf(OpenCodeCliProvider);
    expect(provider.name).toBe('opencode-cli');
  });

  it('is selectable by name against a real config object', () => {
    registerBuiltinProviders();
    const provider = createProvider(config({ apiKey: '', options: { bin: '/usr/local/bin/opencode' } }), { logger });
    expect(provider.model).toBe('opencode/ling-3.1-flash-free');
  });
});
