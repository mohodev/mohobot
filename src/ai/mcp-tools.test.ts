import { describe, expect, it } from 'vitest';
import { createNullLogger } from '../core/logger.js';
import { McpManager } from '../mcp/manager.js';
import type { McpTransport } from '../mcp/types.js';
import { ChatToolRegistry, executeToolCall } from './tools.js';
import { mcpToolName, registerMcpTools } from './mcp-tools.js';

const CTX = { botId: 'bot', channelId: 'chan', userId: 'user' };

function fakeServer(calls: { count: number }): McpTransport {
  return {
    send: async (method: string, params?: unknown) => {
      if (method === 'initialize') return { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'demo', version: '1' } };
      if (method === 'notifications/initialized') return undefined;
      if (method === 'tools/list') {
        return {
          tools: [
            { name: 'search.web', description: 'web search', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
            { name: 'config.set', description: 'set config', inputSchema: { type: 'object', properties: {} } },
          ],
        };
      }
      if (method === 'tools/call') {
        calls.count += 1;
        const p = params as { arguments?: unknown };
        return { content: [{ type: 'text', text: `result:${JSON.stringify(p?.arguments ?? {})}` }] };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}

async function makeManager() {
  const calls = { count: 0 };
  const manager = new McpManager({
    servers: [{ id: 'demo', transport: 'http', url: 'http://127.0.0.1:9/mcp' }],
    logger: createNullLogger(),
    transportFactory: () => fakeServer(calls),
  });
  await manager.start();
  return { manager, calls };
}

describe('MCP -> ChatToolRegistry bridge', () => {
  it('registers MCP tools as model-callable chat tools with input schemas', async () => {
    const { manager } = await makeManager();
    const registry = new ChatToolRegistry();
    const added = registerMcpTools(registry, manager);
    expect(added).toBe(2);
    const defs = registry.definitions();
    const names = defs.map((d) => d.function.name);
    expect(names).toContain('mcp_demo_search_web');
    expect(names).toContain('mcp_demo_config_set');
    const search = defs.find((d) => d.function.name === 'mcp_demo_search_web')!;
    expect(search.function.parameters).toMatchObject({ type: 'object', properties: { q: { type: 'string' } } });
    expect(search.function.description).toContain('[MCP demo]');
  });

  it('routes an allowed tool call through the manager and returns its text wrapped as untrusted', async () => {
    const { manager, calls } = await makeManager();
    const registry = new ChatToolRegistry();
    registerMcpTools(registry, manager);
    const out = await executeToolCall(registry, { id: '1', name: 'mcp_demo_search_web', arguments: '{"q":"hi"}' }, CTX);
    const parsed = JSON.parse(out);
    expect(parsed.type).toBe('untrusted_data');
    expect(parsed.source).toBe('tool');
    expect(parsed.text).toContain('result:{"q":"hi"}');
    expect(calls.count).toBe(1);
  });

  it('denies a viewer-role model call to an admin-only tool before the transport, and audits it', async () => {
    const { manager, calls } = await makeManager();
    const registry = new ChatToolRegistry();
    registerMcpTools(registry, manager);
    const out = await executeToolCall(registry, { id: '1', name: 'mcp_demo_config_set', arguments: '{}' }, CTX);
    expect(out).toContain('error'); // denial surfaces as a tool error string, never throws
    expect(calls.count).toBe(0); // denied before reaching the server
    const audit = manager.audit();
    expect(audit.some((e) => e.outcome === 'denied' && e.tool === 'config.set')).toBe(true);
    expect(audit.some((e) => e.caller.includes('llm:bot:user'))).toBe(true);
  });

  it('sanitises server/tool names into valid LLM tool names', () => {
    expect(mcpToolName('my-server', 'do.thing')).toBe('mcp_my_server_do_thing');
    expect(mcpToolName('s', 'a-b.c_d')).toBe('mcp_s_a_b_c_d');
  });
});
