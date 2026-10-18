/**
 * Cross-surface authorization contract. Keep this table narrower than any
 * individual implementation: untrusted content must never select a stronger
 * caller identity or role.
 */
export type GovernanceSurface = 'chat-model' | 'mcp-viewer' | 'operator' | 'acp' | 'admin';
export type GovernanceAction = 'model.chat' | 'mcp.read' | 'mcp.write' | 'operator.read' | 'operator.write' | 'admin.read' | 'admin.write';

const ALLOWED: Record<GovernanceSurface, readonly GovernanceAction[]> = {
  'chat-model': ['model.chat', 'mcp.read'],
  'mcp-viewer': ['mcp.read'],
  operator: [],
  acp: ['operator.read'],
  admin: ['admin.read', 'admin.write'],
};

export interface AuthorizationDecision {
  allow: boolean;
  reason: string;
}

export function authorizeGovernance(surface: GovernanceSurface, action: GovernanceAction): AuthorizationDecision {
  if (ALLOWED[surface].includes(action)) return { allow: true, reason: 'allowed by surface contract' };
  return { allow: false, reason: `surface '${surface}' cannot perform '${action}'` };
}

export function governanceActions(surface: GovernanceSurface): GovernanceAction[] {
  return [...ALLOWED[surface]];
}

/** Untrusted tool/OCR/MCP/memory text is data, never an authorization source. */
export function authorizationFromUntrustedContent(_content: unknown, fallback: GovernanceSurface): GovernanceSurface {
  return fallback;
}
