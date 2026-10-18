/**
 * Bridge: expose MCP server tools as model-callable chat tools.
 *
 * Each configured MCP tool becomes one {@link ChatTool} in the shared
 * registry, so the reply path (src/pipeline/pipeline.ts `#chatMaybeWithTools`)
 * can offer it to the model alongside built-in tools. The call still goes
 * through `McpManager.callTool`, so the fail-closed permission policy and the
 * redacted audit log apply exactly as they do for admin-initiated calls.
 *
 * Security posture: a model-driven call is attributed to a fixed LOW-privilege
 * role (`viewer` by default), so only MCP tools the policy already allows at
 * that role are reachable by the model. Higher-privilege tools are denied at
 * the gate (and audited as denied) even if the model asks for them.
 */

import type { Logger } from '../core/logger.js';
import type { McpManager } from '../mcp/manager.js';
import { isTextContent, type McpRole } from '../mcp/types.js';
import type { ChatToolRegistry } from './tools.js';

export interface McpBridgeOptions {
  /** Role attributed to model-driven MCP calls; defaults to the lowest role. */
  role?: McpRole;
  logger?: Logger;
}

/** `server` + `name` -> a valid LLM tool name (`/^[a-zA-Z0-9_]+$/`). */
export function mcpToolName(server: string, name: string): string {
  return `mcp_${server}_${name}`.replace(/[^a-zA-Z0-9_]/g, '_');
}

/**
 * Register every cached MCP tool into `registry`. Returns how many were added.
 * Name collisions after sanitisation (two servers producing the same tool
 * name) are skipped with a warning - the first registration wins.
 */
export function registerMcpTools(registry: ChatToolRegistry, mcp: McpManager, options: McpBridgeOptions = {}): number {
  const role: McpRole = options.role ?? 'viewer';
  let added = 0;
  for (const ref of mcp.tools()) {
    const name = mcpToolName(ref.server, ref.name);
    if (registry.has(name)) {
      options.logger?.warn({ tool: name, server: ref.server, mcpTool: ref.name }, 'mcp bridge: skipping colliding tool name');
      continue;
    }
    registry.register({
      definition: {
        type: 'function',
        function: {
          name,
          description: `[MCP ${ref.server}] ${ref.description ?? ref.name}`,
          parameters: ref.inputSchema ?? { type: 'object', properties: {} },
        },
      },
      contextAware: true,
      handler: async (args, context) => {
        const caller = { id: `llm:${context.botId}:${context.userId}`, role };
        const result = await mcp.callTool(ref.server, ref.name, args, caller);
        const text = result.content.filter(isTextContent).map((c) => c.text).join('\n');
        if (result.isError) return { error: text || 'mcp tool error' };
        // Untrusted-data wrapping is applied by executeToolCall (src/ai/tools.ts)
        // which marks all tool results uniformly with source 'tool'.
        return text.length > 0 ? text : { ok: true };
      },
    });
    added += 1;
  }
  return added;
}
