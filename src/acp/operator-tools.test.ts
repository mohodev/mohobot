/**
 * Tests for the ACP operator-tool adapter and the `tools/*` JSON-RPC surface.
 *
 * The tools here are structural fakes (`AcpOperatorTool`), so nothing imports
 * `plugins/` — the wiring site injects the real registry.
 */

import { describe, expect, it, vi } from 'vitest';
import type { AIProvider, AIResponse } from '../ai/types.js';
import { createNullLogger } from '../core/logger.js';
import {
  coerceAcpArgs,
  findAcpTool,
  listAcpTools,
  runAcpTool,
  type AcpOperatorContext,
  type AcpOperatorTool,
} from './operator-tools.js';
import { AcpServer } from './server.js';

function fakeExec(): AcpOperatorContext['exec'] {
  return vi.fn(async () => ({ code: 0, stdout: 'ok', stderr: '' }));
}

function makeContext(): AcpOperatorContext {
  return { rootDir: '/repo', logger: createNullLogger(), exec: fakeExec() };
}

/** Read tool that echoes its context so tests can assert the injected caller. */
function readTool(): AcpOperatorTool {
  return {
    name: 'diag',
    risk: 'read',
    usage: '?op diag health',
    description: '诊断：健康检查',
    run: async (args, ctx) => ({
      ok: true,
      output: `root=${ctx.rootDir} caller=${ctx.callerId} admin=${ctx.isAdmin} args=${args.join(',')}`,
    }),
  };
}

/** Write/danger tools that must never be reached. */
function refusingTool(name: string, risk: 'write' | 'danger'): AcpOperatorTool & { called: boolean } {
  const tool: AcpOperatorTool & { called: boolean } = {
    name,
    risk,
    usage: `?op ${name}`,
    description: `${name} 工具`,
    called: false,
    async run() {
      tool.called = true;
      return { ok: true, output: 'SHOULD NOT RUN' };
    },
  };
  return tool;
}

const TOOLS: readonly AcpOperatorTool[] = [readTool(), refusingTool('patch', 'write'), refusingTool('restart', 'danger')];

function mockProvider(): AIProvider {
  return {
    name: 'test',
    model: 'test-model',
    async chat(): Promise<AIResponse> {
      return { content: 'ok', model: 'test-model', ms: 1 };
    },
    async health() {
      return { ok: true };
    },
  };
}

function createToolServer(operatorTools?: readonly AcpOperatorTool[]): AcpServer {
  return new AcpServer({
    provider: mockProvider(),
    logger: createNullLogger(),
    ...(operatorTools ? { operatorTools, operatorContext: makeContext() } : {}),
  });
}

describe('ACP operator tool adapter', () => {
  it('lists tools with name, description and a string-array schema', () => {
    const list = listAcpTools(TOOLS);
    expect(list.map((t) => t.name)).toEqual(['diag', 'patch', 'restart']);
    expect(list[0]!.description).toContain('诊断：健康检查');
    expect(list[0]!.description).toContain('只读');
    expect(list[2]!.description).toContain('危险');
    expect(list[0]!.inputSchema.type).toBe('object');
    expect(list[0]!.inputSchema.properties.args).toEqual({
      type: 'array',
      items: { type: 'string' },
      description: '用法：?op diag health',
    });
    expect(list[0]!.inputSchema.required).toEqual([]);
  });

  it('finds tools by exact name', () => {
    expect(findAcpTool(TOOLS, 'diag')?.risk).toBe('read');
    expect(findAcpTool(TOOLS, 'DIAG')).toBeUndefined();
    expect(findAcpTool([], 'diag')).toBeUndefined();
  });

  it('runs a read tool with an admin editor context', async () => {
    const ctx = makeContext();
    const out = await runAcpTool(TOOLS, 'diag', ['health'], ctx);
    expect(out).toBe('root=/repo caller=acp admin=true args=health');
  });

  it('refuses write tools with a Chinese explanation and never runs them', async () => {
    const patch = refusingTool('patch', 'write');
    const exec = vi.fn(async () => ({ code: 0, stdout: 'ok', stderr: '' }));
    const ctx: AcpOperatorContext = { rootDir: '/repo', logger: createNullLogger(), exec };
    const out = await runAcpTool([readTool(), patch], 'patch', ['write', 'src/x.ts'], ctx);
    expect(out).toContain('已拒绝');
    expect(out).toContain('二次确认');
    expect(patch.called).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it('refuses danger tools even for the admin editor caller', async () => {
    const restart = refusingTool('restart', 'danger');
    const out = await runAcpTool([readTool(), restart], 'restart', [], makeContext());
    expect(out).toContain('已拒绝');
    expect(out).toContain('破坏性操作');
    expect(restart.called).toBe(false);
  });

  it('returns an explanation for an unknown tool', async () => {
    const out = await runAcpTool([readTool()], 'nope', [], makeContext());
    expect(out).toContain('未知工具：nope');
    expect(out).toContain('diag');
    const empty = await runAcpTool([], 'diag', [], makeContext());
    expect(empty).toContain('未接入任何工具');
  });

  it('turns a throwing tool into an explanation instead of an exception', async () => {
    const boom: AcpOperatorTool = {
      name: 'boom',
      risk: 'read',
      usage: '?op boom',
      description: '会抛错的工具',
      run() {
        throw new Error('kaboom');
      },
    };
    const out = await runAcpTool([boom], 'boom', [], makeContext());
    expect(out).toContain('工具执行失败');
    expect(out).toContain('kaboom');
  });

  it('coerces JSON-RPC arguments into a string array', () => {
    expect(coerceAcpArgs(undefined)).toEqual([]);
    expect(coerceAcpArgs(null)).toEqual([]);
    expect(coerceAcpArgs(['a', 1, true])).toEqual(['a', '1', 'true']);
    expect(coerceAcpArgs([{ path: 'src/x.ts' }])).toEqual(['{"path":"src/x.ts"}']);
    expect(coerceAcpArgs('status')).toBeUndefined();
    expect(coerceAcpArgs({ args: ['status'] })).toBeUndefined();
  });
});

describe('ACP tools JSON-RPC methods', () => {
  it('advertises tools capability in initialize', () => {
    const result = (createToolServer(TOOLS) as any).handleInitialize({});
    expect(result.agentCapabilities.tools).toBe(true);
  });

  it('returns an empty list when no tools are injected', async () => {
    const server = createToolServer();
    const listResult = await (server as any).handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(listResult.result).toEqual({ tools: [] });

    const callResult = await (server as any).handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'diag', arguments: ['health'] },
    });
    expect(callResult.error).toBeDefined();
    expect(callResult.error.code).toBe(-32602);
  });

  it('serves tools/list with descriptors', async () => {
    const server = createToolServer(TOOLS);
    const result = await (server as any).handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(result.error).toBeUndefined();
    expect(result.result.tools.map((t: { name: string }) => t.name)).toEqual(['diag', 'patch', 'restart']);
    expect(result.result.tools[0].inputSchema.properties.args.type).toBe('array');
  });

  it('runs a read tool through tools/call', async () => {
    const server = createToolServer(TOOLS);
    const result = await (server as any).handleRequest({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { sessionId: 'acp_1', name: 'diag', arguments: ['health'] },
    });
    expect(result.error).toBeUndefined();
    expect(result.result.content).toEqual([
      { type: 'text', text: 'root=/repo caller=acp admin=true args=health' },
    ]);
  });

  it('returns write/danger refusals as content, not protocol errors', async () => {
    const server = createToolServer(TOOLS);
    for (const name of ['patch', 'restart']) {
      const result = await (server as any).handleRequest({
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name, arguments: [] },
      });
      expect(result.error).toBeUndefined();
      expect(result.result.content[0].type).toBe('text');
      expect(result.result.content[0].text).toContain('已拒绝');
    }
  });

  it('errors on unknown tools and malformed arguments', async () => {
    const server = createToolServer(TOOLS);
    const unknown = await (server as any).handleRequest({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'nope', arguments: [] },
    });
    expect(unknown.error).toBeDefined();
    expect(unknown.error.code).toBe(-32602);

    const badArgs = await (server as any).handleRequest({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'diag', arguments: 'health' },
    });
    expect(badArgs.error).toBeDefined();
    expect(badArgs.error.code).toBe(-32602);

    const noName = await (server as any).handleRequest({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: {} });
    expect(noName.error).toBeDefined();
    expect(noName.error.code).toBe(-32602);
  });

  it('errors when tools are injected without an operator context', async () => {
    const server = new AcpServer({
      provider: mockProvider(),
      logger: createNullLogger(),
      operatorTools: [readTool()],
    });
    const result = await (server as any).handleRequest({
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'diag', arguments: [] },
    });
    expect(result.error).toBeDefined();
    expect(result.error.code).toBe(-32603);
  });
});
