/**
 * Bounded in-memory audit log for MCP tool calls.
 *
 * Mirrors `AuditTrail` in src/admin/actions.ts: newest-first ring buffer with
 * generated ids and ISO timestamps. Arguments are redacted BEFORE they are
 * stored (spirit of `redactArgs` in src/operator/registry.ts): secret-looking
 * keys are masked outright and every value is capped to a short preview, so
 * the log can never become a credential leak.
 */

export type McpAuditOutcome = 'allowed' | 'denied' | 'error';

export interface McpAuditEntry {
  id: string;
  at: string;
  tool: string;
  caller: string;
  outcome: McpAuditOutcome;
  detail: string;
  argsRedacted: string;
}

export const AUDIT_CAP = 200;
export const MAX_ARG_CHARS = 160;
export const MAX_DETAIL_CHARS = 200;
const MAX_VALUE_CHARS = 24;

/** Keys whose values must never be stored, even as a preview. */
const SECRET_KEY = /token|secret|passw|credential|authorization|auth|api[-_]?key|^key$/i;

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function preview(value: unknown): string {
  if (typeof value === 'string') return truncate(value, MAX_VALUE_CHARS);
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return truncate(JSON.stringify(value) ?? String(value), MAX_VALUE_CHARS);
  } catch {
    return '[unserializable]';
  }
}

/** Render call arguments as a short, secret-free one-liner safe for the audit log. */
export function redactArgs(args: unknown): string {
  if (args === null || args === undefined) return '';
  if (typeof args === 'object' && !Array.isArray(args)) {
    return truncate(Object.entries(args as Record<string, unknown>)
      .map(([key, value]) => `${key}=${SECRET_KEY.test(key) ? '[REDACTED]' : preview(value)}`)
      .join(' '), MAX_ARG_CHARS);
  }
  return truncate(preview(args), MAX_ARG_CHARS);
}

export class McpAuditLog {
  readonly #entries: McpAuditEntry[] = [];
  readonly #cap: number;

  constructor(cap: number = AUDIT_CAP) {
    this.#cap = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : AUDIT_CAP;
  }

  get size(): number { return this.#entries.length; }

  record(entry: Omit<McpAuditEntry, 'id' | 'at'>): McpAuditEntry {
    const row: McpAuditEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(),
      tool: entry.tool,
      caller: entry.caller,
      outcome: entry.outcome,
      // Defensive: even pre-redacted input is capped again so one huge blob
      // cannot bloat the ring buffer.
      detail: truncate(entry.detail, MAX_DETAIL_CHARS),
      argsRedacted: truncate(entry.argsRedacted, MAX_ARG_CHARS),
    };
    this.#entries.unshift(row);
    this.#entries.splice(this.#cap);
    return row;
  }

  /** Newest first; `limit` returns just the most recent entries. */
  list(limit?: number): McpAuditEntry[] {
    if (limit === undefined) return [...this.#entries];
    return this.#entries.slice(0, Math.max(0, Math.floor(limit)));
  }
}
