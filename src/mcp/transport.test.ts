import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNullLogger } from '../core/logger.js';
import { HttpTransport, StdioTransport } from './transport.js';

/** Minimal Response stand-in so the tests never touch a real socket. */
function jsonResponse(body: unknown, init: { ok?: boolean; status?: number; statusText?: string } = {}): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    text: async () => text,
    json: async () => JSON.parse(text),
  } as unknown as Response;
}

function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

/** Line-delimited JSON-RPC echo server run as a real, short-lived child. */
const ECHO_SERVER = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message && message.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { echo: message.method, params: message.params } }) + '\\n');
  }
});
`;

const EXIT_IMMEDIATELY = 'process.exit(0);';
const NEVER_ANSWERS = 'process.stdin.resume();';

const opened: StdioTransport[] = [];

function stdio(args: string[], timeoutMs?: number): StdioTransport {
  const transport = new StdioTransport({ command: process.execPath, args, timeoutMs, logger: createNullLogger() });
  opened.push(transport);
  return transport;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(opened.splice(0).map((transport) => transport.close()));
});

describe('HttpTransport', () => {
  it('posts a JSON-RPC request and resolves with the result field', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: { tools: ['a'] } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const transport = new HttpTransport({ url: 'https://mcp.example/rpc' });
    await expect(transport.send('tools/list', { cursor: 'x' })).resolves.toEqual({ tools: ['a'] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calls[0]!.url).toBe('https://mcp.example/rpc');
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>)['content-type']).toBe('application/json');
    const body = bodyOf(calls[0]!.init);
    expect(body['jsonrpc']).toBe('2.0');
    expect(body['method']).toBe('tools/list');
    expect(body['params']).toEqual({ cursor: 'x' });
    expect(typeof body['id']).toBe('number');
  });

  it('throws when the JSON-RPC body carries an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'method not found' } })));
    const transport = new HttpTransport({ url: 'https://mcp.example/rpc' });
    await expect(transport.send('nope')).rejects.toThrow(/method not found/);
  });

  it('throws on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse('', { ok: false, status: 503, statusText: 'Service Unavailable' })));
    const transport = new HttpTransport({ url: 'https://mcp.example/rpc' });
    await expect(transport.send('tools/list')).rejects.toThrow(/503/);
  });

  it('honours timeoutMs even when fetch never settles', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => { /* never resolves */ })));
    const transport = new HttpTransport({ url: 'https://mcp.example/rpc', timeoutMs: 20 });
    await expect(transport.send('initialize')).rejects.toThrow(/timed out after 20ms/);
  });

  it('resolves notifications without a request id or a body', async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      seen.push(init);
      return jsonResponse('', { status: 202, statusText: 'Accepted' });
    }));
    const transport = new HttpTransport({ url: 'https://mcp.example/rpc' });
    await expect(transport.send('notifications/initialized')).resolves.toBeUndefined();
    expect(bodyOf(seen[0]!)['id']).toBeUndefined();
  });

  it('rejects malformed urls and non-http protocols', () => {
    expect(() => new HttpTransport({ url: 'ftp://mcp.example/rpc' })).toThrow(/http or https/);
    expect(() => new HttpTransport({ url: 'not a url' })).toThrow();
    expect(() => new HttpTransport({ url: '' })).toThrow();
  });
});

describe('StdioTransport', () => {
  it('round-trips a request through a real child process', async () => {
    const transport = stdio(['-e', ECHO_SERVER], 5000);
    await expect(transport.send('tools/list', { cursor: 'a' })).resolves.toEqual({ echo: 'tools/list', params: { cursor: 'a' } });
    // A second request reuses the same child and matches by its own id.
    await expect(transport.send('initialize', { protocolVersion: 'x' })).resolves.toEqual({ echo: 'initialize', params: { protocolVersion: 'x' } });
  });

  it('resolves notifications without waiting for a response', async () => {
    const transport = stdio(['-e', ECHO_SERVER], 5000);
    await expect(transport.send('notifications/initialized')).resolves.toBeUndefined();
    // The child is still healthy afterwards.
    await expect(transport.send('ping')).resolves.toEqual({ echo: 'ping' });
  });

  it('rejects pending requests when the child exits early', async () => {
    const transport = stdio(['-e', EXIT_IMMEDIATELY], 5000);
    await expect(transport.send('initialize')).rejects.toThrow(/exited|not running|error/);
  });

  it('rejects a request the server never answers once timeoutMs elapses', async () => {
    const transport = stdio(['-e', NEVER_ANSWERS], 200);
    await expect(transport.send('initialize')).rejects.toThrow(/timed out after 200ms/);
  });

  it('validates the command before spawning', () => {
    expect(() => new StdioTransport({ command: '' })).toThrow(/non-empty command/);
    expect(() => new StdioTransport({ command: 'node\0evil' })).toThrow(/NUL/);
    expect(() => new StdioTransport({ command: 'node', args: [1 as unknown as string] })).toThrow(/array of strings/);
  });

  it('refuses to send after close()', async () => {
    const transport = stdio(['-e', ECHO_SERVER], 5000);
    await transport.close();
    await expect(transport.send('ping')).rejects.toThrow(/closed/);
  });
});