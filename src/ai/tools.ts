/**
 * LLM function/tool-calling registry (port of upstream
 * `mohobot/services/llm_tools.py`).
 *
 * Hard rules honoured here:
 *  - `executeToolCall` NEVER throws: every failure becomes a JSON
 *    `{"error": ...}` string the model can read;
 *  - duplicate or malformed tool names are rejected at registration time.
 */

import type { ChatToolCall } from '../core/types.js';
import type { ChatToolDefinition } from './types.js';

export interface ChatToolContext {
  botId: string;
  channelId: string;
  userId: string;
}

export interface ChatTool {
  definition: ChatToolDefinition;
  /** Return any JSON-serialisable value or a string; thrown errors become an error result, never escape. */
  handler: (args: Record<string, unknown>, context: ChatToolContext) => unknown | Promise<unknown>;
  /** When false, handler receives no context (pure/read-only tools). */
  contextAware?: boolean;
}

const TOOL_NAME = /^[a-zA-Z0-9_]+$/;

export class ChatToolRegistry {
  readonly #tools = new Map<string, ChatTool>();

  register(tool: ChatTool): void {
    const name = tool.definition.function.name;
    if (!TOOL_NAME.test(name)) throw new Error(`invalid tool name: ${name}`);
    if (this.#tools.has(name)) throw new Error(`tool already registered: ${name}`);
    this.#tools.set(name, tool);
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  get(name: string): ChatTool | undefined {
    return this.#tools.get(name);
  }

  definitions(): ChatToolDefinition[] {
    return [...this.#tools.values()].map((tool) => tool.definition);
  }

  get size(): number {
    return this.#tools.size;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Execute one tool call; ALWAYS returns a string result (JSON), never throws. */
export async function executeToolCall(
  registry: ChatToolRegistry,
  call: ChatToolCall,
  context: ChatToolContext,
): Promise<string> {
  const tool = registry.get(call.name);
  if (!tool) return JSON.stringify({ error: `未知工具: ${call.name}` });

  let args: unknown;
  try {
    args = JSON.parse(call.arguments);
  } catch {
    return JSON.stringify({ error: '工具参数必须是有效的 JSON' });
  }
  if (!isPlainObject(args)) return JSON.stringify({ error: '工具参数必须是 JSON 对象' });

  try {
    const result = tool.contextAware === false
      ? await tool.handler(args, undefined as unknown as ChatToolContext)
      : await tool.handler(args, context);
    if (typeof result === 'string') return result;
    return JSON.stringify(result) ?? 'null';
  } catch (error) {
    return JSON.stringify({ error: `工具执行失败: ${errorMessage(error)}` });
  }
}
