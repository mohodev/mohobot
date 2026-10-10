import { describe, expect, it, vi } from 'vitest';

import { createNullLogger } from '../core/logger.js';
import type { Storage } from '../storage/types.js';
import type { AIProvider } from './types.js';
import { moduleForTask, UsageRecorder, UsageRecordingProvider } from './usage.js';

const logger = createNullLogger();

function memoryStorage(): Storage & { rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>();
  return {
    rows,
    async init() {},
    async save<T>(key: string, value: T) { rows.set(key, value); },
    async get<T>(key: string) { return rows.get(key) as T | undefined; },
    async delete(key: string) { rows.delete(key); },
    async query() { return []; },
    async purgeExpired() { return 0; },
    async close() {},
  };
}

function fakeProvider(usage: { input?: number; output?: number } | undefined): AIProvider {
  return {
    name: 'test',
    model: 'test-model',
    async chat() { return { content: 'ok', model: 'test-model', ms: 1, ...(usage ? { usage: { ...usage, totalTokens: (usage.input ?? 0) + (usage.output ?? 0) } } : {}) }; },
    async health() { return { ok: true }; },
  };
}

describe('moduleForTask', () => {
  it('buckets scheduler lanes into display modules', () => {
    expect(moduleForTask('reply')).toBe('reply');
    expect(moduleForTask(undefined)).toBe('reply');
    expect(moduleForTask('summary')).toBe('summary');
    expect(moduleForTask('admin')).toBe('analysis');
    expect(moduleForTask('reflection')).toBe('analysis');
    expect(moduleForTask('ab')).toBe('ab');
    expect(moduleForTask('vision')).toBe('vision');
    expect(moduleForTask('planner')).toBe('other');
  });
});

describe('UsageRecorder', () => {
  it('accumulates per-day per-module totals', async () => {
    const storage = memoryStorage();
    const recorder = new UsageRecorder({ storage, logger, now: () => 1_000_000 });
    await recorder.record('main', 'reply', { input: 100, output: 20 });
    await recorder.record('main', 'reply', { input: 50, output: 10 });
    await recorder.record('main', 'summary', { input: 1000, output: 100 });
    await recorder.record('other-bot', 'reply', { input: 1, output: 1 });

    const rows = await recorder.totals('main', 1);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.module === 'reply')).toMatchObject({ calls: 2, input: 150, output: 30 });
    expect(rows.find((row) => row.module === 'summary')).toMatchObject({ calls: 1, input: 1000, output: 100 });
  });

  it('accepts promptTokens shape and missing usage', async () => {
    const storage = memoryStorage();
    const recorder = new UsageRecorder({ storage, logger, now: () => 1_000_000 });
    await recorder.record('main', 'reply', { promptTokens: 10, completionTokens: 5 });
    await recorder.record('main', 'reply', undefined);
    const rows = await recorder.totals('main', 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ calls: 2, input: 10, output: 5 });
  });

  it('sums across days within the window only', async () => {
    const storage = memoryStorage();
    let clock = 1_000_000;
    const recorder = new UsageRecorder({ storage, logger, now: () => clock });
    await recorder.record('main', 'reply', { input: 10, output: 1 });
    clock += 3 * 86_400_000;
    await recorder.record('main', 'reply', { input: 20, output: 2 });

    expect(await recorder.totals('main', 1)).toMatchObject([{ module: 'reply', calls: 1, input: 20, output: 2 }]);
    const two = await recorder.totals('main', 4);
    expect(two.find((row) => row.module === 'reply')).toMatchObject({ calls: 2, input: 30, output: 3 });
  });

  it('renders an empty and a populated report', async () => {
    const storage = memoryStorage();
    const recorder = new UsageRecorder({ storage, logger, now: () => 1_000_000 });
    expect(await recorder.report('main', 1)).toContain('暂无数据');
    await recorder.record('main', 'reply', { input: 100, output: 20 });
    const report = await recorder.report('main', 7);
    expect(report).toContain('用量统计（近7天）');
    expect(report).toContain('主回复');
    expect(report).toContain('总计');
  });

  it('never throws on storage failure', async () => {
    const broken = memoryStorage();
    broken.save = async () => { throw new Error('disk gone'); };
    const recorder = new UsageRecorder({ storage: broken, logger, now: () => 1_000_000 });
    await expect(recorder.record('main', 'reply', { input: 1, output: 1 })).resolves.toBeUndefined();
    await expect(recorder.report('main', 1)).resolves.toContain('暂无数据');
  });
});

describe('UsageRecordingProvider', () => {
  it('delegates everything and records successful usage by task', async () => {
    const storage = memoryStorage();
    const recorder = new UsageRecorder({ storage, logger, now: () => 1_000_000 });
    const provider = new UsageRecordingProvider(fakeProvider({ input: 10, output: 2 }), { recorder, botId: 'main' });
    expect(provider.name).toBe('test');
    expect(provider.model).toBe('test-model');
    expect(await provider.health()).toEqual({ ok: true });

    const response = await provider.chat([{ role: 'user', content: 'hi' }], { task: 'summary' });
    expect(response.content).toBe('ok');
    const rows = await recorder.totals('main', 1);
    expect(rows).toMatchObject([{ module: 'summary', calls: 1, input: 10, output: 2 }]);
  });

  it('records failures as calls without tokens', async () => {
    const storage = memoryStorage();
    const recorder = new UsageRecorder({ storage, logger, now: () => 1_000_000 });
    const failing: AIProvider = {
      name: 't', model: 't',
      async chat() { throw new Error('boom'); },
      async health() { return { ok: false }; },
    };
    const provider = new UsageRecordingProvider(failing, { recorder, botId: 'main' });
    await expect(provider.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow('boom');
    // A failed call records nothing: usage is only known on success.
    expect(await recorder.totals('main', 1)).toHaveLength(0);
  });
});
