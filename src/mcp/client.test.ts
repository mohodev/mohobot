import { describe, expect, it } from 'vitest';

import { McpClient, MCP_PROTOCOL_VERSION } from './client.js';
import { McpAuditLog, McpToolPolicy } from './index.js';
import { McpError, isTextContent, type McpCaller, type McpTransport } from './types.js';

type Handler = (params: unknown) => unknown;

/** Resolve to the rejection reason so typed-error assertions stay explicit. */
async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => undefined, (error: unknown) => error);
}

/** In-memory stand-in for a real MCP server; counts every JSON-RPC request. */
class FakeTransport implements McpTransport {
  callCount = 0;
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
  countOf(method: string): number {
    return this.calls.filter((call) => call.method === method).length;
  }
}

function serverTransport(overrides: Record<string, Handler> = {}): FakeTransport {
  return new FakeTransport({
    initialize: () => ({ protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, serverInfo: { name: 'fake-mcp', version: '0.1.0' } }),
    'notifications/initialized': () => undefined,
    'tools/list': () => ({
      tools: [
        { name: 'search.web', description: 'Search the web', inputSchema: { type: 'object' } },
        { name: 'config.set', description: 'Mutate config', inputSchema: { type: 'object' } },
        { name: 42 },
      ],
    }),
    'tools/call': (params) => {
      const call = params as { name?: string; arguments?: Record<string, unknown> };
      const args = call.arguments ?? {};
      if (args['fail'] === true) throw new Error('socket hang up');
      if (args['broken'] === true) return null;
      if (args['toolError'] === true) return { content: [{ type: 'text', text: 'tool exploded' }], isError: true };
      if (args['image'] === true) return { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] };
      return { content: [{ type: 'text', text: `called ${call.name}` }] };
    },
    ...overrides,
  });
}

const viewer: McpCaller = { id: 'u1', role: 'viewer' };
const admin: McpCaller = { id: 'root', role: 'admin' };

async function readyClient(overrides: Record<string, Handler> = {}): Promise<{ client: McpClient; transport: FakeTransport }> {
  const transport = serverTransport(overrides);
  const client = new McpClient(transport);
  await client.initialize();
  return { client, transport };
}

function texts(result: { content: Parameters<typeof isTextContent>[0][] }): string[] {
  return result.content.filter(isTextContent).map((part) => part.text);
}

describe('McpClient', () => {
  it('handshakes and lists tools, skipping malformed entries', async () => {
    const { client, transport } = await readyClient();
    expect(client.initialized).toBe(true);
    expect(client.serverInfo).toEqual({ name: 'fake-mcp', version: '0.1.0' });
    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['search.web', 'config.set']);
    expect(tools[0]!.description).toBe('Search the web');
    expect(tools[0]!.inputSchema).toEqual({ type: 'object' });
    expect(transport.countOf('tools/list')).toBe(1);
    // initialize is idempotent: a second call does not hit the transport again.
    const before = transport.callCount;
    await client.initialize();
    expect(transport.callCount).toBe(before);
  });

  it('refuses tools/list before initialize', async () => {
    const client = new McpClient(serverTransport());
    const error = await caught(client.listTools());
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe('protocol');
  });

  it('wraps a failing handshake into a typed McpError', async () => {
    const transport = serverTransport({ initialize: () => { throw new Error('connection refused'); } });
    const client = new McpClient(transport);
    const error = await caught(client.initialize());
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe('transport');
    expect(client.initialized).toBe(false);
  });

  it('calls an allowed tool through the transport and returns its content', async () => {
    const { client, transport } = await readyClient();
    const result = await client.callTool('search.web', { q: 'mohobot' }, viewer);
    expect(result.isError).toBeUndefined();
    expect(texts(result)).toEqual(['called search.web']);
    const call = transport.calls.find((entry) => entry.method === 'tools/call');
    expect(call?.params).toEqual({ name: 'search.web', arguments: { q: 'mohobot' } });
    const [entry] = client.auditLog.list();
    expect(entry).toMatchObject({ tool: 'search.web', caller: 'u1 (viewer)', outcome: 'allowed', argsRedacted: 'q=mohobot' });
  });

  it('passes non-text content parts through as-is', async () => {
    const { client } = await readyClient();
    const result = await client.callTool('search.web', { image: true }, viewer);
    expect(result.content[0]).toMatchObject({ type: 'image', data: 'AAAA', mimeType: 'image/png' });
  });

  it('never touches the transport for a denied tool and records the denial', async () => {
    const { client, transport } = await readyClient();
    const before = transport.callCount;
    const error = await caught(client.callTool('config.set', { apiKey: 'SUPERSECRET123', mode: 'fast' }, viewer));
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe('denied');
    expect((error as McpError).message).toContain("requires role 'admin'");
    expect(transport.callCount).toBe(before);
    expect(transport.countOf('tools/call')).toBe(0);
    const entries = client.auditLog.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ tool: 'config.set', outcome: 'denied' });
    expect(JSON.stringify(entries)).not.toContain('SUPERSECRET123');
    expect(entries[0]!.argsRedacted).toContain('[REDACTED]');
    expect(entries[0]!.argsRedacted).toContain('mode=fast');
  });

  it('allows the same tool for a caller with a sufficient role', async () => {
    const { client } = await readyClient();
    const result = await client.callTool('config.set', { mode: 'fast' }, admin);
    expect(texts(result)).toEqual(['called config.set']);
    expect(client.auditLog.list()[0]).toMatchObject({ caller: 'root (admin)', outcome: 'allowed' });
  });

  it('surfaces transport failures as typed errors without crashing the client', async () => {
    const { client } = await readyClient();
    const error = await caught(client.callTool('search.web', { fail: true }, viewer));
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe('transport');
    expect((error as McpError).tool).toBe('search.web');
    expect((error as McpError).message).toContain('socket hang up');
    // The client is still usable afterwards.
    const result = await client.callTool('search.web', { q: 'again' }, viewer);
    expect(texts(result)).toEqual(['called search.web']);
    expect(client.auditLog.list().map((entry) => entry.outcome)).toEqual(['allowed', 'error']);
  });

  it('treats malformed tools/call payloads as protocol errors', async () => {
    const { client } = await readyClient();
    const error = await caught(client.callTool('search.web', { broken: true }, viewer));
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe('protocol');
    expect(client.auditLog.list()[0]!.outcome).toBe('error');
  });

  it('returns tool-level isError results instead of throwing, audited as error', async () => {
    const { client } = await readyClient();
    const result = await client.callTool('search.web', { toolError: true }, viewer);
    expect(result.isError).toBe(true);
    expect(texts(result)).toEqual(['tool exploded']);
    expect(client.auditLog.list()[0]).toMatchObject({ outcome: 'error', detail: 'tool exploded' });
  });

  it('records every outcome - allowed, denied and error - newest first', async () => {
    const { client } = await readyClient();
    await client.callTool('search.web', { q: 'ok' }, viewer);
    await client.callTool('config.set', {}, viewer).catch(() => undefined);
    await client.callTool('search.web', { fail: true }, viewer).catch(() => undefined);
    expect(client.auditLog.list().map((entry) => entry.outcome)).toEqual(['error', 'denied', 'allowed']);
    expect(client.auditLog.list().map((entry) => entry.tool)).toEqual(['search.web', 'config.set', 'search.web']);
  });

  it('gates calls before the handshake: denied stays denied, allowed fails closed', async () => {
    const transport = serverTransport();
    const client = new McpClient(transport);
    const denied = await caught(client.callTool('config.set', {}, viewer));
    expect(denied).toBeInstanceOf(McpError);
    expect((denied as McpError).code).toBe('denied');
    const tooEarly = await caught(client.callTool('search.web', {}, viewer));
    expect(tooEarly).toBeInstanceOf(McpError);
    expect((tooEarly as McpError).code).toBe('protocol');
    expect(transport.countOf('tools/call')).toBe(0);
    expect(client.auditLog.list().map((entry) => entry.outcome)).toEqual(['error', 'denied']);
  });

  it('accepts an injected policy and audit log', async () => {
    const audit = new McpAuditLog(10);
    const policy = new McpToolPolicy([{ pattern: 'config.set', minRole: 'viewer' }]);
    const client = new McpClient(serverTransport(), undefined, { policy, audit });
    await client.initialize();
    await client.callTool('config.set', {}, viewer);
    expect(audit.list()[0]).toMatchObject({ tool: 'config.set', outcome: 'allowed' });
    expect(client.auditLog).toBe(audit);
    expect(client.policy).toBe(policy);
  });
});
