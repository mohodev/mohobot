/**
 * Tool-level permission policy for MCP calls.
 *
 * Mirrors the spirit of src/admin/rbac.ts (ordered roles, pure `can`-style
 * decisions) but simplified to one axis: every tool rule names a minimum
 * role, and anything not covered by a rule is DENIED (fail closed) - an
 * unknown or renamed tool never inherits access.
 *
 * Pure functions only; no I/O, no SDKs, trivially testable.
 */

import type { McpCaller, McpRole } from './types.js';

/** Role ladder: a role satisfies any rule requiring it or a lower rank. */
const ROLE_RANK: Record<McpRole, number> = { viewer: 0, operator: 1, admin: 2, developer: 3 };

export interface McpToolRule {
  /** Exact tool name, or a prefix pattern ending in `*` (e.g. `system.*`). */
  pattern: string;
  /** Lowest role allowed to call matching tools. */
  minRole: McpRole;
}

export interface McpDecision {
  allow: boolean;
  reason: string;
}

export class McpToolPolicy {
  readonly #rules: McpToolRule[];

  constructor(rules: readonly McpToolRule[]) {
    this.#rules = rules.map((rule) => ({ ...rule }));
  }

  get rules(): McpToolRule[] { return this.#rules.map((rule) => ({ ...rule })); }

  /** Decide whether `caller` may invoke `tool`. Never throws; denies on any doubt. */
  authorize(tool: string, caller: McpCaller | undefined): McpDecision {
    if (!caller || !caller.id) return { allow: false, reason: 'missing caller identity' };
    const rank = ROLE_RANK[caller.role];
    if (typeof rank !== 'number') return { allow: false, reason: `unknown caller role '${String(caller.role)}'` };
    const rule = this.#match(tool);
    if (!rule) return { allow: false, reason: `tool '${tool}' is not covered by the policy (default deny)` };
    if (rank < ROLE_RANK[rule.minRole]) {
      return { allow: false, reason: `tool '${tool}' requires role '${rule.minRole}' (caller is '${caller.role}')` };
    }
    return { allow: true, reason: `tool '${tool}' allowed for role '${caller.role}' (requires '${rule.minRole}')` };
  }

  /** Exact-name rules win over patterns; among patterns, declaration order wins. */
  #match(tool: string): McpToolRule | undefined {
    return this.#rules.find((rule) => rule.pattern === tool)
      ?? this.#rules.find((rule) => rule.pattern.endsWith('*') && tool.startsWith(rule.pattern.slice(0, -1)));
  }
}

/**
 * Example policy: read-only tools open to every caller, mutating or
 * system-level tools gated to admin and above.
 */
export const defaultPolicy = new McpToolPolicy([
  { pattern: 'search.web', minRole: 'viewer' },
  { pattern: 'wiki.summary', minRole: 'viewer' },
  { pattern: 'songs.list', minRole: 'viewer' },
  { pattern: 'config.set', minRole: 'admin' },
  { pattern: 'system.*', minRole: 'admin' },
]);
