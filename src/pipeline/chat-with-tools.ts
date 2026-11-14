import type { ResolvedBotConfig } from '../config/schema.js';
import type { ChatMessage, MohoMessage } from '../core/types.js';
import type { Logger } from '../core/logger.js';
import type { AIProvider, AIResponse } from '../ai/types.js';
import { executeToolCall, type ChatToolRegistry } from '../ai/tools.js';
import type { ChatTrace, ChatTraceStore } from './chat-trace.js';

export interface ChatWithToolsInput {
  messages: ChatMessage[];
  config: ResolvedBotConfig;
  provider: AIProvider;
  tools?: ChatToolRegistry;
  signal: AbortSignal;
  message: MohoMessage;
  trace: ChatTrace;
  logger: Logger;
  onTrace: (
    trace: ChatTrace,
    stage: Parameters<ChatTraceStore['add']>[1],
    detail?: Parameters<ChatTraceStore['add']>[2],
  ) => void;
  onDelta?: (delta: string) => void;
}

function toolDefinitions(config: ResolvedBotConfig, registry?: ChatToolRegistry) {
  if (!config.ai.tools.enabled || !registry || registry.size === 0) return [];
  const allow = config.ai.tools.allow;
  const definitions = registry.definitions();
  return allow.length === 0
    ? definitions
    : definitions.filter((definition) => allow.includes(definition.function.name));
}

/**
 * Execute one normal provider call or a bounded tool-calling loop.
 * Tool calls force non-streaming; without tools the original streaming path,
 * delta callback and channel accounting hint are preserved.
 */
export async function chatWithTools(input: ChatWithToolsInput): Promise<AIResponse> {
  const {
    messages, config, provider, tools, signal, message, trace, logger, onTrace, onDelta,
  } = input;
  const definitions = toolDefinitions(config, tools);

  if (definitions.length === 0) {
    return provider.chat(messages, {
      temperature: config.ai.temperature,
      timeoutMs: config.ai.timeoutMs,
      stream: config.ai.stream,
      signal,
      channelId: message.channel.id,
      onDelta: config.ai.stream
        ? (delta) => {
            onDelta?.(delta);
            onTrace(trace, 'delta', { length: delta.length });
          }
        : undefined,
    });
  }

  const registry = tools!;
  const context = { botId: config.id, channelId: message.channel.id, userId: message.author.id };
  const thread: ChatMessage[] = [...messages];
  let last: AIResponse | undefined;

  for (let round = 0; round < config.ai.tools.maxRounds; round += 1) {
    const response = await provider.chat(thread, {
      temperature: config.ai.temperature,
      timeoutMs: config.ai.timeoutMs,
      stream: false,
      signal,
      channelId: message.channel.id,
      tools: definitions,
    });
    last = response;
    if (!response.toolCalls || response.toolCalls.length === 0) return response;

    onTrace(trace, 'model_tool_calls', { round, count: response.toolCalls.length });
    thread.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls });
    for (const call of response.toolCalls) {
      const output = await executeToolCall(registry, call, context);
      logger.info({ tool: call.name, traceId: trace.id }, 'llm tool executed');
      // The provider accepts tool messages; the AIProvider interface stays
      // narrow, so this is the single protocol seam for the tool role.
      thread.push({ role: 'tool', toolCallId: call.id, name: call.name, content: output } as unknown as ChatMessage);
    }
  }

  return last!;
}
