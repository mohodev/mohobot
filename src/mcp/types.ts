/**
 * Minimal MCP (Model Context Protocol) types for the in-repo tool layer.
 *
 * The protocol surface we care about is JSON-RPC 2.0 with three methods:
 * `initialize`, `tools/list` and `tools/call`. The transport seam below keeps
 * the client transport-agnostic (stdio, HTTP, in-memory fake for tests); no
 * SDK is imported so this module stays dependency-free like src/operator.
 */

/** Roles mirror src/admin/rbac.ts; each role includes the ones below it. */
export type McpRole = 'viewer' | 'operator' | 'admin' | 'developer';

/** A tool as advertised by an MCP server's `tools/list` response. */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpTextContent { type: 'text'; text: string; }

/** Any other MCP content part (image, audio, embedded resource) passes through as-is. */
export interface McpGenericContent { type: string; [key: string]: unknown; }

export type McpContent = McpTextContent | McpGenericContent;

/** Result of a `tools/call`; `isError` marks tool-level failures (not transport ones). */
export interface McpCallResult {
  content: McpContent[];
  isError?: boolean;
}

/**
 * Request/response transport seam. One call maps to one JSON-RPC request;
 * implementations own framing, timeouts and connection handling.
 */
export interface McpTransport {
  send(method: string, params?: unknown): Promise<unknown>;
}

/** Who is asking. Permission decisions are made per caller role. */
export interface McpCaller {
  id: string;
  role: McpRole;
}

export type McpErrorCode = 'denied' | 'transport' | 'protocol' | 'tool';

/** Typed failure for the MCP layer: denial, transport faults, malformed payloads. */
export class McpError extends Error {
  readonly code: McpErrorCode;
  readonly tool: string | undefined;
  constructor(code: McpErrorCode, message: string, options?: { tool?: string; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'McpError';
    this.code = code;
    this.tool = options?.tool;
  }
}

export function isTextContent(content: McpContent): content is McpTextContent {
  return content.type === 'text' && typeof (content as McpTextContent).text === 'string';
}
