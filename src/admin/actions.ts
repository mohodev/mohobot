import type { BotSnapshot } from '../bot/runtime.js';

export type ActionRisk = 'read' | 'reversible' | 'impact' | 'dangerous';
export interface AdminAction { id: string; title: string; risk: ActionRisk; confirmation: boolean; description: string; }
export interface AuditEntry { id: string; at: string; actor: string; action: string; outcome: 'allowed' | 'denied'; detail: string; }

/**
 * Explicit allowlist for the administrator persona. This intentionally is not
 * a shell/SQL proxy: adding an operation means implementing and reviewing it.
 */
export const ADMIN_ACTIONS: readonly AdminAction[] = [
  { id: 'runtime.status', title: 'Runtime status', risk: 'read', confirmation: false, description: 'Read bot, gateway and pipeline snapshots.' },
  { id: 'runtime.health', title: 'Dependency health', risk: 'read', confirmation: false, description: 'Read configured service connectivity, never credentials.' },
  { id: 'plugin.list', title: 'Plugin inventory', risk: 'read', confirmation: false, description: 'Read loaded plugin records.' },
  { id: 'plugin.reload', title: 'Reload plugin', risk: 'reversible', confirmation: true, description: 'Reload one existing plugin after explicit confirmation.' },
  { id: 'mysql.health', title: 'MySQL health', risk: 'read', confirmation: false, description: 'Reserved: read-only connectivity check through a least-privilege account.' },
  { id: 'redis.health', title: 'Redis health', risk: 'read', confirmation: false, description: 'Reserved: read-only connectivity check through a namespaced ACL account.' },
] as const;

export class AuditTrail {
  readonly #entries: AuditEntry[] = [];
  record(entry: Omit<AuditEntry, 'id' | 'at'>): AuditEntry {
    const row: AuditEntry = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: new Date().toISOString(), ...entry };
    this.#entries.unshift(row);
    this.#entries.splice(200);
    return row;
  }
  list(): AuditEntry[] { return [...this.#entries]; }
}

export function healthSnapshot(bots: BotSnapshot[]): Record<string, unknown> {
  return {
    runtime: bots.length > 0 ? 'up' : 'idle',
    mysql: { configured: Boolean(process.env.MOHO_MYSQL_URL), connected: false, mode: 'not-probed' },
    redis: { configured: Boolean(process.env.MOHO_REDIS_URL), connected: false, mode: 'not-probed' },
    bots: bots.length,
  };
}
