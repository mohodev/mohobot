/**
 * Tests for the ACP server protocol handling.
 *
 * These tests verify the JSON-RPC message handling, session management,
 * and content block conversion without needing a real stdio connection.
 */

import { describe, expect, it, vi } from 'vitest';
import type { AIProvider, AIResponse, ChatOptions } from '../ai/types.js';
import type { ChatMessage } from '../core/types.js';
import { createNullLogger } from '../core/logger.js';
import { AcpServer } from './server.js';

function mockProvider(reply: string | ((messages: ChatMessage[], options?: ChatOptions) => Promise<AIResponse>)): AIProvider & { calls: Array<{ messages: ChatMessage[]; options?: ChatOptions }> } {
  const calls: Array<{ messages: ChatMessage[]; options?: ChatOptions }> = [];
  return {
    name: 'test',
    model: 'test-model',
    calls,
    async chat(messages, options) {
      calls.push({ messages, options });
      if (typeof reply === 'function') return reply(messages, options);
      return { content: reply, model: 'test-model', ms: 1 };
    },
    async health() { return { ok: true }; },
  };
}

function createServer(provider: AIProvider): AcpServer {
  return new AcpServer({ provider, logger: createNullLogger() });
}

describe('ACP server', () => {
  it('handles initialize with correct capabilities', () => {
    const server = createServer(mockProvider('ok'));
    // Access private method for testing
    const result = (server as any).handleInitialize({});
    expect(result.protocolVersion).toBe(1);
    expect(result.agentInfo.name).toBe('MohoBot');
    expect(result.agentCapabilities.promptCapabilities.embeddedContext).toBe(true);
    expect(result.agentCapabilities.loadSession).toBe(false);
  });

  it('creates and deletes sessions', () => {
    const server = createServer(mockProvider('ok'));
    const newResult = (server as any).handleSessionNew({ cwd: '/tmp' });
    expect(newResult.sessionId).toMatch(/^acp_\d+$/);

    const listResult = (server as any).handleSessionList();
    expect(listResult).toHaveLength(1);

    const deleteResult = (server as any).handleSessionDelete({ sessionId: newResult.sessionId });
    expect(deleteResult).toEqual({});

    const listAfter = (server as any).handleSessionList();
    expect(listAfter).toHaveLength(0);
  });

  it('converts text content blocks to a user message', async () => {
    const provider = mockProvider('Hello!');
    const server = createServer(provider);
    const newResult = (server as any).handleSessionNew({ cwd: '/tmp' });
    const sessionId = newResult.sessionId;

    const promptResult = await (server as any).handleSessionPrompt(1, {
      sessionId,
      prompt: [{ type: 'text', text: 'Hello, how are you?' }],
    });

    expect(promptResult.result.stopReason).toBe('end_turn');
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.messages.at(-1)).toEqual({ role: 'user', content: 'Hello, how are you?' });
  });

  it('converts resource content blocks', async () => {
    const provider = mockProvider('ok');
    const server = createServer(provider);
    const newResult = (server as any).handleSessionNew({ cwd: '/tmp' });
    const sessionId = newResult.sessionId;

    await (server as any).handleSessionPrompt(1, {
      sessionId,
      prompt: [
        { type: 'text', text: 'What is in this file?' },
        { type: 'resource', resource: { uri: 'file:///test.ts', text: 'export const x = 1;' } },
      ],
    });

    const lastCall = provider.calls.at(-1);
    expect(lastCall?.messages.at(-1)?.content).toContain('What is in this file?');
    expect(lastCall?.messages.at(-1)?.content).toContain('export const x = 1;');
  });

  it('handles session/cancel notification', () => {
    const server = createServer(mockProvider('ok'));
    const newResult = (server as any).handleSessionNew({ cwd: '/tmp' });
    const sessionId = newResult.sessionId;

    // Should not throw
    (server as any).handleCancel({ sessionId });

    // Verify the session's abort controller was aborted
    const session = (server as any).sessions.get(sessionId);
    expect(session.abortController.signal.aborted).toBe(true);
  });

  it('returns error for unknown session', async () => {
    const server = createServer(mockProvider('ok'));
    const result = await (server as any).handleSessionPrompt(1, {
      sessionId: 'nonexistent',
      prompt: [{ type: 'text', text: 'hi' }],
    });
    expect(result.error).toBeDefined();
    expect(result.error.code).toBe(-32602);
  });

  it('returns error for empty prompt', async () => {
    const server = createServer(mockProvider('ok'));
    const newResult = (server as any).handleSessionNew({ cwd: '/tmp' });
    const result = await (server as any).handleSessionPrompt(1, {
      sessionId: newResult.sessionId,
      prompt: [],
    });
    expect(result.error).toBeDefined();
  });

  it('accumulates session history across prompts', async () => {
    const provider = mockProvider('response');
    const server = createServer(provider);
    const newResult = (server as any).handleSessionNew({ cwd: '/tmp' });
    const sessionId = newResult.sessionId;

    await (server as any).handleSessionPrompt(1, {
      sessionId,
      prompt: [{ type: 'text', text: 'First message' }],
    });
    await (server as any).handleSessionPrompt(2, {
      sessionId,
      prompt: [{ type: 'text', text: 'Second message' }],
    });

    const lastCall = provider.calls.at(-1);
    expect(lastCall?.messages).toHaveLength(3);
    expect(lastCall?.messages[0]).toEqual({ role: 'user', content: 'First message' });
    expect(lastCall?.messages[1]).toEqual({ role: 'assistant', content: 'response' });
    expect(lastCall?.messages[2]).toEqual({ role: 'user', content: 'Second message' });
  });

  it('returns cancelled stop reason when aborted', async () => {
    const provider = mockProvider(async (_messages, options) => {
      // Simulate a slow response that gets cancelled
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (options?.signal?.aborted) {
        throw new Error('The operation was aborted');
      }
      return { content: 'done', model: 'test', ms: 1 };
    });
    const server = createServer(provider);
    const newResult = (server as any).handleSessionNew({ cwd: '/tmp' });
    const sessionId = newResult.sessionId;

    // Start the prompt but don't await it yet
    const promptPromise = (server as any).handleSessionPrompt(1, {
      sessionId,
      prompt: [{ type: 'text', text: 'slow' }],
    });

    // Cancel it
    (server as any).handleCancel({ sessionId });

    const result = await promptPromise;
    expect(result.result.stopReason).toBe('cancelled');
  });
});
