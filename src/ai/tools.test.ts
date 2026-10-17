import { describe, expect, it, vi } from 'vitest';

import type { ChatToolCall } from '../core/types.js';
import {
  ChatToolRegistry,
  executeToolCall,
  type ChatTool,
  type ChatToolContext,
} from './tools.js';
import type { ChatToolDefinition } from './types.js';

const context: ChatToolContext = { botId: 'b1', channelId: 'c1', userId: 'u1' };

function definition(name: string): ChatToolDefinition {
  return {
    type: 'function',
    function: { name, description: `${name} tool`, parameters: { type: 'object', properties: {} } },
  };
}

function tool(name: string, handler: ChatTool['handler'], contextAware?: boolean): ChatTool {
  return { definition: definition(name), handler, ...(contextAware !== undefined ? { contextAware } : {}) };
}

function call(name: string, args: unknown): ChatToolCall {
  return { id: 'call-1', name, arguments: typeof args === 'string' ? args : JSON.stringify(args) };
}

describe('ChatToolRegistry', () => {
  it('registers tools and exposes them via has/get/size', () => {
    const registry = new ChatToolRegistry();
    const t = tool('get_time', () => 'now');
    registry.register(t);

    expect(registry.has('get_time')).toBe(true);
    expect(registry.get('get_time')).toBe(t);
    expect(registry.has('nope')).toBe(false);
    expect(registry.get('nope')).toBeUndefined();
    expect(registry.size).toBe(1);
  });

  it('rejects a duplicate tool name', () => {
    const registry = new ChatToolRegistry();
    registry.register(tool('get_time', () => 'a'));
    expect(() => registry.register(tool('get_time', () => 'b'))).toThrow(/already registered/);
    expect(registry.size).toBe(1);
  });

  it('rejects invalid tool names', () => {
    const registry = new ChatToolRegistry();
    for (const name of ['', 'bad-name', 'has space', '中文名', 'dots.x']) {
      expect(() => registry.register(tool(name, () => null))).toThrow(/invalid tool name/);
    }
    expect(registry.size).toBe(0);
    registry.register(tool('ok_Name123', () => null));
    expect(registry.size).toBe(1);
  });

  it('returns every registered definition via definitions()', () => {
    const registry = new ChatToolRegistry();
    registry.register(tool('alpha', () => null));
    registry.register(tool('beta', () => null));

    const defs = registry.definitions();
    expect(defs.map((d) => d.function.name)).toEqual(['alpha', 'beta']);
    expect(defs.every((d) => d.type === 'function')).toBe(true);
    expect(defs[0]).toEqual(definition('alpha'));
  });
});

describe('executeToolCall', () => {
  it('returns a string handler result as-is', async () => {
    const registry = new ChatToolRegistry();
    registry.register(tool('echo', (args) => `got:${String(args.text)}`));
    const result = await executeToolCall(registry, call('echo', { text: 'hi' }), context);
    expect(result).toBe('got:hi');
  });

  it('JSON-stringifies a non-string handler result', async () => {
    const registry = new ChatToolRegistry();
    registry.register(tool('sum', async (args) => ({ total: Number(args.a) + Number(args.b) })));
    const result = await executeToolCall(registry, call('sum', { a: 2, b: 3 }), context);
    expect(result).toBe('{"total":5}');
    expect(JSON.parse(result)).toEqual({ total: 5 });
  });

  it('reports an unknown tool as an error result', async () => {
    const registry = new ChatToolRegistry();
    const result = await executeToolCall(registry, call('missing_tool', {}), context);
    expect(JSON.parse(result)).toEqual({ error: '未知工具: missing_tool' });
  });

  it('reports invalid JSON arguments as an error result', async () => {
    const registry = new ChatToolRegistry();
    const handler = vi.fn(() => 'unreachable');
    registry.register(tool('echo', handler));
    const result = await executeToolCall(registry, call('echo', '{not json'), context);
    expect(JSON.parse(result)).toEqual({ error: '工具参数必须是有效的 JSON' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('reports non-object arguments as an error result', async () => {
    const registry = new ChatToolRegistry();
    const handler = vi.fn(() => 'unreachable');
    registry.register(tool('echo', handler));
    for (const args of ['[1,2]', '"text"', '42', 'null']) {
      const result = await executeToolCall(registry, call('echo', args), context);
      expect(JSON.parse(result)).toEqual({ error: '工具参数必须是 JSON 对象' });
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('converts a thrown handler error into an error result', async () => {
    const registry = new ChatToolRegistry();
    registry.register(tool('boom', () => { throw new Error('kaboom'); }));
    registry.register(tool('boom_async', async () => { throw new Error('async kaboom'); }));
    registry.register(tool('boom_string', () => { throw 'plain failure'; }));

    await expect(executeToolCall(registry, call('boom', {}), context)).resolves.toBe(
      '{"error":"工具执行失败: kaboom"}',
    );
    expect(JSON.parse(await executeToolCall(registry, call('boom_async', {}), context))).toEqual({
      error: '工具执行失败: async kaboom',
    });
    expect(JSON.parse(await executeToolCall(registry, call('boom_string', {}), context))).toEqual({
      error: '工具执行失败: plain failure',
    });
  });

  it('passes the context to contextAware tools', async () => {
    const registry = new ChatToolRegistry();
    const handler = vi.fn((_args: Record<string, unknown>, ctx: ChatToolContext) => ctx.channelId);
    registry.register(tool('where', handler));
    const result = await executeToolCall(registry, call('where', {}), context);
    expect(result).toBe('c1');
    expect(handler).toHaveBeenCalledWith({}, context);
  });

  it('withholds the context from non-contextAware tools', async () => {
    const registry = new ChatToolRegistry();
    const handler = vi.fn((_args: Record<string, unknown>, _ctx?: ChatToolContext) => 'pure');
    registry.register(tool('pure_math', handler, false));
    const result = await executeToolCall(registry, call('pure_math', { x: 1 }), context);
    expect(result).toBe('pure');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toEqual({ x: 1 });
    expect(handler.mock.calls[0]?.[1]).toBeUndefined();
  });

  it('never rejects, even when the handler throws', async () => {
    const registry = new ChatToolRegistry();
    registry.register(tool('die', () => { throw new Error('dead'); }));
    await expect(executeToolCall(registry, call('die', {}), context)).resolves.toEqual(
      expect.stringContaining('工具执行失败'),
    );
  });
});
