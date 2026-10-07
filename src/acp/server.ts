/**
 * ACP (Agent Client Protocol) v1 server for MohoBot.
 *
 * Exposes MohoBot's AI provider over stdio using JSON-RPC 2.0, so any
 * ACP-compatible editor (Zed, VS Code, JetBrains, Avante.nvim, etc.) can
 * use MohoBot as a coding agent backend.
 *
 * Supported methods:
 *   - initialize: negotiate protocol version and capabilities
 *   - session/new: create a new conversation session
 *   - session/prompt: send a user message and stream the response
 *   - session/cancel: cancel an in-flight prompt
 *
 * Notifications:
 *   - session/update: stream agent message chunks
 *
 * Usage:
 *   npx tsx src/acp/server.ts
 *   # or after build:
 *   node dist/src/acp/server.js
 *
 * Editor configuration example (Zed):
 *   { "agent_servers": { "MohoBot": { "command": "npx", "args": ["tsx", "src/acp/server.ts"] } } }
 */

import type { AIProvider, AIResponse, ChatOptions } from '../ai/types.js';
import type { ChatMessage } from '../core/types.js';
import type { Logger } from '../core/logger.js';

// ── JSON-RPC 2.0 types ─────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

type IncomingMessage = JsonRpcRequest | JsonRpcNotification;

// ── ACP types ───────────────────────────────────────────────────────────────

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string; uri?: string }
  | { type: 'audio'; mimeType: string; data: string }
  | { type: 'resource'; resource: { uri: string; mimeType?: string; text?: string; blob?: string } }
  | { type: 'resource_link'; uri: string; name: string; mimeType?: string; title?: string; description?: string; size?: number };

type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

interface Session {
  id: string;
  messages: ChatMessage[];
  abortController: AbortController;
  createdAt: number;
}

// ── Server ──────────────────────────────────────────────────────────────────

export interface AcpServerOptions {
  provider: AIProvider;
  logger: Logger;
  /** Protocol version to advertise. */
  protocolVersion?: number;
  /** Agent name shown in editors. */
  agentName?: string;
  /** Agent version. */
  agentVersion?: string;
}

export class AcpServer {
  private readonly provider: AIProvider;
  private readonly logger: Logger;
  private readonly protocolVersion: number;
  private readonly agentName: string;
  private readonly agentVersion: string;

  private readonly sessions = new Map<string, Session>();
  private nextSessionId = 1;
  private nextMessageId = 1;

  constructor(opts: AcpServerOptions) {
    this.provider = opts.provider;
    this.logger = opts.logger.child({ component: 'acp' });
    this.protocolVersion = opts.protocolVersion ?? 1;
    this.agentName = opts.agentName ?? 'MohoBot';
    this.agentVersion = opts.agentVersion ?? '1.0.0';
  }

  /** Start reading JSON-RPC messages from stdin and writing to stdout. */
  async start(): Promise<void> {
    const stdin = process.stdin;
    const stdout = process.stdout;

    stdin.setEncoding('utf8');
    let buffer = '';

    stdin.on('data', (chunk: string) => {
      buffer += chunk;
      // Messages are newline-delimited JSON
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.handleLine(trimmed).catch((error: unknown) => {
          this.logger.error({ err: error instanceof Error ? error.message : String(error) }, 'ACP message handling failed');
        });
      }
    });

    stdin.on('end', () => {
      this.logger.info('stdin closed, shutting down');
      process.exit(0);
    });

    stdin.on('error', (error: Error) => {
      this.logger.error({ err: error.message }, 'stdin error');
      process.exit(1);
    });

    // Keep the process alive
    stdout.write('');
  }

  private async handleLine(line: string): Promise<void> {
    let message: IncomingMessage;
    try {
      message = JSON.parse(line) as IncomingMessage;
    } catch {
      this.logger.warn('Invalid JSON received, ignoring');
      return;
    }

    if ('id' in message) {
      // Request
      const response = await this.handleRequest(message);
      if (response) {
        process.stdout.write(JSON.stringify(response) + '\n');
      }
    } else {
      // Notification
      await this.handleNotification(message);
    }
  }

  private async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse | undefined> {
    const { id, method, params } = request;
    try {
      switch (method) {
        case 'initialize':
          return { jsonrpc: '2.0', id, result: this.handleInitialize(params ?? {}) };
        case 'session/new':
          return { jsonrpc: '2.0', id, result: this.handleSessionNew(params ?? {}) };
        case 'session/prompt':
          return await this.handleSessionPrompt(id, params ?? {});
        case 'session/load':
          return { jsonrpc: '2.0', id, error: { code: -32601, message: 'session/load not supported' } };
        case 'session/delete':
          return { jsonrpc: '2.0', id, result: this.handleSessionDelete(params ?? {}) };
        case 'session/list':
          return { jsonrpc: '2.0', id, result: this.handleSessionList() };
        case 'session/set_mode':
          return { jsonrpc: '2.0', id, result: {} };
        case 'logout':
          return { jsonrpc: '2.0', id, result: {} };
        case 'authenticate':
          return { jsonrpc: '2.0', id, result: {} };
        default:
          return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ method, err: message }, 'ACP request failed');
      return { jsonrpc: '2.0', id, error: { code: -32603, message } };
    }
  }

  private async handleNotification(notification: JsonRpcNotification): Promise<void> {
    const { method, params } = notification;
    switch (method) {
      case 'session/cancel':
        this.handleCancel(params ?? {});
        break;
      default:
        this.logger.debug({ method }, 'Ignoring ACP notification');
    }
  }

  // ── Method handlers ───────────────────────────────────────────────────────

  private handleInitialize(_params: Record<string, unknown>): Record<string, unknown> {
    return {
      protocolVersion: this.protocolVersion,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: {
          image: false,
          audio: false,
          embeddedContext: true,
        },
        mcpCapabilities: {
          http: false,
          sse: false,
        },
        auth: {
          logout: false,
        },
        sessionCapabilities: {
          delete: {},
        },
      },
      agentInfo: {
        name: this.agentName,
        title: this.agentName,
        version: this.agentVersion,
      },
      authMethods: [],
    };
  }

  private handleSessionNew(params: Record<string, unknown>): Record<string, unknown> {
    const id = `acp_${this.nextSessionId++}`;
    const cwd = typeof params.cwd === 'string' ? params.cwd : process.cwd();
    this.sessions.set(id, {
      id,
      messages: [],
      abortController: new AbortController(),
      createdAt: Date.now(),
    });
    this.logger.info({ sessionId: id, cwd }, 'ACP session created');
    return { sessionId: id };
  }

  private async handleSessionPrompt(id: number | string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `Session not found: ${sessionId}` } };
    }

    const prompt = params.prompt as ContentBlock[] | undefined;
    if (!prompt || !Array.isArray(prompt)) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: 'prompt must be an array of content blocks' } };
    }

    // Convert ACP content blocks to a single user message
    const textParts: string[] = [];
    for (const block of prompt) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'resource' && block.resource.text) {
        textParts.push(block.resource.text);
      } else if (block.type === 'resource_link') {
        textParts.push(`[Resource: ${block.name}](${block.uri})`);
      } else if (block.type === 'image') {
        textParts.push('[Image attached]');
      } else if (block.type === 'audio') {
        textParts.push('[Audio attached]');
      }
    }
    const userText = textParts.join('\n');
    if (!userText.trim()) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: 'No text content in prompt' } };
    }

    // Add user message to session history
    const userMessage: ChatMessage = { role: 'user', content: userText };
    session.messages.push(userMessage);

    // Build the messages array for the provider
    const messages: ChatMessage[] = [...session.messages];
    const messageId = `acp_msg_${this.nextMessageId++}`;

    // Stream the response
    let fullResponse = '';
    const options: ChatOptions = {
      stream: true,
      signal: session.abortController.signal,
      onDelta: (delta: string) => {
        fullResponse += delta;
        this.sendUpdate(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          messageId,
          content: { type: 'text', text: delta },
        });
      },
    };

    try {
      const response: AIResponse = await this.provider.chat(messages, options);
      // If streaming didn't produce deltas, send the full response
      if (!fullResponse && response.content) {
        fullResponse = response.content;
        this.sendUpdate(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          messageId,
          content: { type: 'text', text: response.content },
        });
      }
      // Add assistant message to session history
      session.messages.push({ role: 'assistant', content: fullResponse });
      return { jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Check if it was cancelled
      if (session.abortController.signal.aborted) {
        return { jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } };
      }
      this.logger.error({ err: message }, 'ACP prompt failed');
      return { jsonrpc: '2.0', id, error: { code: -32603, message } };
    }
  }

  private handleSessionDelete(params: Record<string, unknown>): Record<string, unknown> {
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
    const existed = this.sessions.delete(sessionId);
    if (existed) {
      this.logger.info({ sessionId }, 'ACP session deleted');
    }
    return {};
  }

  private handleSessionList(): Array<{ sessionId: string; cwd: string }> {
    return [...this.sessions.values()].map((s) => ({
      sessionId: s.id,
      cwd: process.cwd(),
    }));
  }

  private handleCancel(params: Record<string, unknown>): void {
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
    const session = this.sessions.get(sessionId);
    if (session) {
      session.abortController.abort();
      this.logger.info({ sessionId }, 'ACP prompt cancelled');
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private sendUpdate(sessionId: string, update: Record<string, unknown>): void {
    const notification = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId, update },
    };
    process.stdout.write(JSON.stringify(notification) + '\n');
  }
}
