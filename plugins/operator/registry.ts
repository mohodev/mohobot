/**
 * Compatibility shim.
 *
 * The operator registry now lives in src/operator/registry.ts so the chat
 * plugin, the ACP server and the admin WebUI share ONE registry (including the
 * process boot marker that invalidates staged confirmations after a restart).
 * This module only re-exports it; nothing should add logic here.
 */

export * from '../../src/operator/registry.js';
