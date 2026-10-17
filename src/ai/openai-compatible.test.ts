import { describe, expect, it } from 'vitest';

import { AIConfigSchema, type AIConfig } from '../config/schema.js';
import { createNullLogger } from '../core/logger.js';
import type { ChatMessage, ToolChatMessage } from '../core/types.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { AIError, type ChatToolDefinition } from './types.js';

const logger = createNullLogger();
const messages: ChatMessage[] = [
  { role: 'system', content: 'you are a test bot' },
  { role: 'user', content: 'ping' },
];

const tools: ChatToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'get_time',
      description: 'get the current time',
      parameters: { type: 'object', properties: { tz: { type: 'string' } } },
    },
  },
];

function cfg(overrides: Partial<AIConfig> = {}): AIConfig {
  return AIConfigSchema.parse({
    baseUrl: 'https://api.example.test/v1',
    apiKey: 'test-key-123456',
    model: 'test-model',
    retryBaseDelayMs: 1,
    timeoutMs: 5000,
    retries: 0,
    ...overrides,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function completion(content: string): unknown {
  return {
    model: 'test-model',
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
  };
}

function toolCallCompletion(): unknown {
  return {
    model: 'test-model',
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'get_time', arguments: '{"tz":"UTC"}' } },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 },
  };
}

/** Captures the parsed request body of the single chat() call. */
async function captureBody(
  chatMessages: Array<ChatMessage | ToolChatMessage>,
  options: Parameters<OpenAICompatibleProvider['chat']>[1],
  responseBody: unknown = completion('ok'),
  cfgOverrides: Partial<AIConfig> = {},
): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (_url: unknown, init: unknown) => {
    body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
    return jsonResponse(responseBody);
  }) as unknown as typeof fetch;
  const provider = new OpenAICompatibleProvider(cfg(cfgOverrides), { logger, fetchImpl });
  await provider.chat(chatMessages, options);
  return body;
}

describe('OpenAICompatibleProvider tool calling', () => {
  it('sends tools in the request body and forces stream off even when streaming was requested', async () => {
    const body = await captureBody(messages, { tools, stream: true, onDelta: () => {} });
    expect(body.tools).toEqual(tools);
    expect(body.stream).toBe(false);
  });

  it('does not send a tools key when no tools are given', async () => {
    const body = await captureBody(messages, undefined);
    expect(body).not.toHaveProperty('tools');
    expect(body.messages).toEqual([
      { role: 'system', content: 'you are a test bot' },
      { role: 'user', content: 'ping' },
    ]);
  });

  it('resolves a tool_calls response with empty content instead of throwing empty-completion', async () => {
    const fetchImpl = (async () => jsonResponse(toolCallCompletion())) as unknown as typeof fetch;
    const provider = new OpenAICompatibleProvider(cfg(), { logger, fetchImpl });
    const res = await provider.chat(messages, { tools });

    expect(res.content).toBe('');
    expect(res.toolCalls).toEqual([{ id: 'call_1', name: 'get_time', arguments: '{"tz":"UTC"}' }]);
    expect(res.finishReason).toBe('tool_calls');
    expect(res.usage?.totalTokens).toBe(26);
  });

  it('still throws the empty-completion AIError when neither content nor tool_calls are present', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ model: 'test-model', choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }] })) as unknown as typeof fetch;
    const provider = new OpenAICompatibleProvider(cfg(), { logger, fetchImpl });
    const err = (await provider.chat(messages, { tools }).catch((e: unknown) => e)) as AIError;
    expect(err).toBeInstanceOf(AIError);
    expect(err.kind).toBe('server');
    expect(err.message).toContain('empty completion');
  });

  it('serializes assistant toolCalls and tool messages into the request body', async () => {
    const history: Array<ChatMessage | ToolChatMessage> = [
      { role: 'user', content: 'what time is it?' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'get_time', arguments: '{"tz":"UTC"}' }],
      },
      { role: 'tool', toolCallId: 'call_1', name: 'get_time', content: '{"time":"12:00"}' },
    ];
    const body = await captureBody(history, { tools }, completion('It is 12:00 UTC.'));

    expect(body.messages).toEqual([
      { role: 'user', content: 'what time is it?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_time', arguments: '{"tz":"UTC"}' } }],
      },
      { role: 'tool', content: '{"time":"12:00"}', tool_call_id: 'call_1', name: 'get_time' },
    ]);
    expect(body.tools).toEqual(tools);
  });

  it('keeps the plain message wire format unchanged', async () => {
    const named: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi', name: 'alice' },
    ];
    const body = await captureBody(named, undefined);
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi', name: 'alice' },
    ]);
    expect(body).not.toHaveProperty('tools');
    expect(body.stream).toBe(false);
  });
});
