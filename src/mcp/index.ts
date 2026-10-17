/**
 * Public surface of the in-repo MCP tool layer:
 * minimal client + per-tool permission policy + bounded call audit log.
 */

export * from './types.js';
export * from './permissions.js';
export * from './audit.js';
export { McpClient, MCP_PROTOCOL_VERSION, type McpClientOptions } from './client.js';
