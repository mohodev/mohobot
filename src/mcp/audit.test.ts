import { describe, expect, it } from 'vitest';

import { McpAuditLog, MAX_ARG_CHARS, MAX_DETAIL_CHARS, redactArgs } from './audit.js';

function entry(tool: string, overrides: Partial<Parameters<McpAuditLog['record']>[0]> = {}) {
  return { tool, caller: 'u1 (viewer)', outcome: 'allowed' as const, detail: 'ok', argsRedacted: '', ...overrides };
}

describe('MCP audit log', () => {
  it('caps the ring buffer and drops the oldest entries', () => {
    const log = new McpAuditLog(5);
    for (let i = 0; i < 8; i += 1) log.record(entry(`tool-${i}`));
    expect(log.list()).toHaveLength(5);
    expect(log.size).toBe(5);
    expect(log.list().map((row) => row.tool)).toEqual(['tool-7', 'tool-6', 'tool-5', 'tool-4', 'tool-3']);
  });

  it('lists newest first and honours the limit', () => {
    const log = new McpAuditLog();
    log.record(entry('first'));
    log.record(entry('second'));
    log.record(entry('third'));
    expect(log.list().map((row) => row.tool)).toEqual(['third', 'second', 'first']);
    expect(log.list(2).map((row) => row.tool)).toEqual(['third', 'second']);
    expect(log.list(0)).toEqual([]);
  });

  it('stamps entries with an id and an ISO timestamp', () => {
    const row = new McpAuditLog().record(entry('search.web'));
    expect(row.id).toMatch(/^\d+-[a-z0-9]+$/);
    expect(new Date(row.at).toISOString()).toBe(row.at);
  });

  it('masks secret-looking argument keys before storing', () => {
    const rendered = redactArgs({ apiKey: 'SUPERSECRETVALUE', token: 'abc123', query: 'weather' });
    expect(rendered).not.toContain('SUPERSECRETVALUE');
    expect(rendered).not.toContain('abc123');
    expect(rendered).toContain('[REDACTED]');
    expect(rendered).toContain('query=weather');
  });

  it('truncates long values to a short preview', () => {
    const secret = 'x'.repeat(500);
    const rendered = redactArgs({ payload: secret });
    expect(rendered).not.toContain(secret);
    expect(rendered.length).toBeLessThanOrEqual(MAX_ARG_CHARS + 1);
    expect(rendered).toMatch(/…$/);
    expect(redactArgs('plain-string')).toBe('plain-string');
    expect(redactArgs(undefined)).toBe('');
  });

  it('truncates oversized detail and args defensively at record time', () => {
    const log = new McpAuditLog();
    const row = log.record(entry('tool', { detail: 'd'.repeat(1000), argsRedacted: 'a'.repeat(1000) }));
    expect(row.detail.length).toBeLessThanOrEqual(MAX_DETAIL_CHARS + 1);
    expect(row.argsRedacted.length).toBeLessThanOrEqual(MAX_ARG_CHARS + 1);
  });

  it('keeps stored entries free of raw argument values end to end', () => {
    const log = new McpAuditLog();
    log.record(entry('config.set', { argsRedacted: redactArgs({ password: 'hunter2-secret', mode: 'fast' }) }));
    const stored = JSON.stringify(log.list());
    expect(stored).not.toContain('hunter2-secret');
    expect(stored).toContain('[REDACTED]');
    expect(stored).toContain('mode=fast');
  });
});
