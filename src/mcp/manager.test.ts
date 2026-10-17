import { describe, expect, it } from 'vitest';

import { createNullLogger } from '../core/logger.js';
import { McpAuditLog } from './audit.js';
import { McpManager, type McpServerConfig, type McpTransportFactory } from './manager.js';
import { McpError, isTextContent, type McpCaller, type McpTransport } from './types.js';

type Handler = (params: unknown) => unknown;

/** Resolve to the rejection reason so typed-error assertions stay explicit. */
async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => undefined, (error: unknown) => error);
}

/** In-memory stand-in for a server's transport; records and can be closed. */
class FakeTransport implements McpTransport {
  callCount = 0;
  closed = false;
  readonly calls: Array<{ method: string; params: unknown }> = [];
  readonly #handlers: Record<string, Handler>;

  constructor(handlers: Record<string, Handler>) { this.#handlers = handlers; }

  async send(method: string, params?: unknown): Promise<unknown> {
    this.callCount += 1;
    this.calls.push({ method, params });
    const handler = this.#handlers[method];
    if (!handler) throw new Error(`unexpected mcp method: ${method}`);
    return handler(params);
  }

  close(): void { this.closed = true; }

  countOf(method: string): number {
    return this.calls.filter((call) => call.method === method).length;
  }
}

function server(overrides: Record<string, Handler> = {}): FakeTransport {
  return new FakeTransport({
    initialize: () => ({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake-mcp', version: '0.1.0' } }),
    'notifications/initialized': () => undefined,
    'tools/list': () => ({ tools: [] }),
    'tools/call': (params) => {
      const call = params as { name?: string };
      return { content: [{ type: 'text', text: `called ${call.name}` }] };
    },
    ...overrides,
  });
}

const viewer: McpCaller = { id: 'u1', role: 'viewer' };
const admin: McpCaller = { id: 'root', role: 'admin' };

const CONFIGS: McpServerConfig[] = [
  {
    id: 'alpha',
    transport: 'http',
    url: 'https://alpha.example/rpc',
    policy: [{ pattern: 'search.web', minRole: 'viewer' }, { pattern: 'config.set', minRole: 'admin' }],
  },
  {
    id: 'beta',
    transport: 'stdio',
    command: 'node',
    policy: [{ pattern: 'wiki.summary', minRole: 'viewer' }],
  },
  { id: 'broken', transport: 'stdio', command: 'node' },
  { id: 'off', enabled: false, transport: 'http', url: 'https://off.example/rpc' },
];

interface Harness {
  manager: McpManager;
  transports: Map<string, FakeTransport>;
  audit: McpAuditLog;
}

function harness(overrides: Record<string, FakeTransport> = {}): Harness {
  const transports = new Map<string, FakeTransport>();
  const audit = new McpAuditLog();
  const factory: McpTransportFactory = (config) => {
    const created = transportFor(config.id);
    transports.set(config.id, created);
    return created;
  };
  function transportFor(id: string): FakeTransport {
    const existing = overrides[id];
    if (existing) return existing;
    if (id === 'alpha') {
      return server({
        'tools/list': () => ({
          tools: [
            { name: 'search.web', description: 'Search the web' },
            { name: 'config.set', description: 'Mutate config' },
            { name: 'search.web', description: 'duplicate' },
          ],
        }),
      });
    }
    if (id === 'beta') {
      return server({ 'tools/list': () => ({ tools: [{ name: 'wiki.summary', description: 'Summarize' }] }) });
    }
    // Everything else refuses to handshake.
    return server({ initialize: () => { throw new Error('boom: connection refused'); } });
  }
  const manager = new McpManager({ servers: CONFIGS, logger: createNullLogger(), audit, transportFactory: factory });
  return { manager, transports, audit };
}

describe('McpManager', () => {
  it('initializes every enabled server and caches its tools', async () => {
    const { manager, transports } = harness();
    await manager.start();

    expect(manager.enabledServers).toBe(3);
    const byId = new Map(manager.status().map((status) => [status.id, status]));
    expect(byId.get('alpha')).toMatchObject({ transport: 'http', initialized: true, toolCount: 3, error: undefined });
    expect(byId.get('beta')).toMatchObject({ transport: 'stdio', initialized: true, toolCount: 1 });
    expect(byId.get('off')).toMatchObject({ initialized: false, toolCount: 0 });
    expect(transports.has('off')).toBe(false);
  });

  it('is idempotent: a second start() does not re-handshake', async () => {
    const { manager, transports } = harness();
    await manager.start();
    const before = transports.get('alpha')!.countOf('initialize');
    await manager.start();
    expect(transports.get('alpha')!.countOf('initialize')).toBe(before);
  });

  it('records a broken server without rejecting start(), other servers keep working', async () => {
    const { manager, transports } = harness();
    await expect(manager.start()).resolves.toBeUndefined();

    const broken = manager.status().find((status) => status.id === 'broken');
    expect(broken).toMatchObject({ initialized: false, toolCount: 0 });
    expect(broken?.error).toContain('boom: connection refused');
    expect(transports.get('alpha')!.countOf('initialize')).toBe(1);
    expect(manager.tools().some((tool) => tool.server === 'alpha')).toBe(true);
  });

  it('flattens and dedupes tools by server+name', async () => {
    const { manager } = harness();
    await manager.start();
    expect(manager.tools().map((tool) => `${tool.server}:${tool.name}`)).toEqual([
      'alpha:search.web',
      'alpha:config.set',
      'beta:wiki.summary',
    ]);
    expect(manager.tools()[0]!.description).toBe('Search the web');
  });

  it('routes an allowed call to that server and returns its content', async () => {
    const { manager, transports } = harness();
    await manager.start();
    const alpha = transports.get('alpha')!;
    const before = alpha.callCount;

    const result = await manager.callTool('alpha', 'search.web', { q: 'mohobot' }, viewer);
    expect(result.content.filter(isTextContent).map((part) => part.text)).toEqual(['called search.web']);
    expect(alpha.countOf('tools/call')).toBe(1);
    expect(alpha.callCount).toBe(before + 1);
    // The call landed on alpha, not on beta.
    expect(transports.get('beta')!.countOf('tools/call')).toBe(0);
  });

  it('denies a tool missing from the policy before the transport is touched', async () => {
    const { manager, transports, audit } = harness();
    await manager.start();
    const alpha = transports.get('alpha')!;
    const before = alpha.callCount;

    const error = await caught(manager.callTool('alpha', 'config.set', { apiKey: 'SUPERSECRET123' }, viewer));
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe('denied');
    expect(alpha.callCount).toBe(before);
    expect(alpha.countOf('tools/call')).toBe(0);

    const entries = manager.audit();
    expect(entries[0]).toMatchObject({ tool: 'config.set', outcome: 'denied' });
    expect(JSON.stringify(entries)).not.toContain('SUPERSECRET123');
    expect(audit.list()).toHaveLength(1);
  });

  it('allows the same tool for a caller with enough role', async () => {
    const { manager } = harness();
    await manager.start();
    const result = await manager.callTool('alpha', 'config.set', { mode: 'fast' }, admin);
    expect(result.content.filter(isTextContent).map((part) => part.text)).toEqual(['called config.set']);
  });

  it('throws a typed McpError for an unknown or disabled server', async () => {
    const { manager } = harness();
    await manager.start();

    const unknown = await caught(manager.callTool('ghost', 'x', {}, viewer));
    expect(unknown).toBeInstanceOf(McpError);
    expect((unknown as McpError).code).toBe('tool');
    expect((unknown as McpError).message).toContain("'ghost'");

    const disabled = await caught(manager.callTool('off', 'x', {}, viewer));
    expect(disabled).toBeInstanceOf(McpError);
    expect((disabled as McpError).code).toBe('tool');

    const failed = await caught(manager.callTool('broken', 'x', {}, viewer));
    expect(failed).toBeInstanceOf(McpError);
    expect((failed as McpError).code).toBe('tool');
  });

  it('merges audit entries from every client, newest first', async () => {
    const { manager } = harness();
    await manager.start();
    await manager.callTool('alpha', 'search.web', { q: 'ok' }, viewer);
    await manager.callTool('beta', 'wiki.summary', {}, viewer);
    await caught(manager.callTool('alpha', 'config.set', {}, viewer));

    const entries = manager.audit();
    expect(entries.map((entry) => entry.outcome)).toEqual(['denied', 'allowed', 'allowed']);
    expect(entries.map((entry) => entry.tool)).toEqual(['config.set', 'wiki.summary', 'search.web']);
    expect(entries.some((entry) => entry.outcome === 'denied')).toBe(true);
  });

  it('stop() closes every transport that exposes close()', async () => {
    const { manager, transports } = harness();
    await manager.start();
    await manager.stop();

    expect(transports.get('alpha')!.closed).toBe(true);
    expect(transports.get('beta')!.closed).toBe(true);
    // A server that failed to start was already closed on the failure path, so
    // no transport is leaked even before stop() runs.
    expect(transports.get('broken')!.closed).toBe(true);
    expect(manager.status().every((status) => status.initialized === false)).toBe(true);
  });

  it('validates a missing command/url through the default factory into status.error', async () => {
    const manager = new McpManager({
      servers: [
        { id: 'no-command', transport: 'stdio' },
        { id: 'no-url', transport: 'http' },
      ],
      logger: createNullLogger(),
    });
    await expect(manager.start()).resolves.toBeUndefined();
    const byId = new Map(manager.status().map((status) => [status.id, status]));
    expect(byId.get('no-command')?.error).toContain('no command');
    expect(byId.get('no-url')?.error).toContain('no url');
    expect(manager.tools()).toEqual([]);
    expect(manager.enabledServers).toBe(2);
  });
});