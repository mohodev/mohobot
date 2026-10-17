/**
 * Compatibility shim.
 *
 * The operator tool implementations now live in src/operator/tools.ts as the
 * single source of truth (shared by this plugin, the ACP server and the admin
 * WebUI). This module only re-exports them; new tools go to src/operator/.
 */

export * from '../../src/operator/tools.js';
