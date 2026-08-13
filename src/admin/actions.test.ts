import { describe, expect, it } from 'vitest';
import { ADMIN_ACTIONS, AuditTrail, healthSnapshot } from './actions.js';

describe('admin action boundary', () => {
  it('has no arbitrary shell, SQL, or Redis command action', () => {
    expect(ADMIN_ACTIONS.map((action) => action.id)).not.toContain('shell.exec');
    expect(ADMIN_ACTIONS.map((action) => action.id)).not.toContain('mysql.query');
    expect(ADMIN_ACTIONS.map((action) => action.id)).not.toContain('redis.command');
  });
  it('records audit entries and never exposes configured URLs', () => {
    const trail = new AuditTrail();
    trail.record({ actor: 'admin', action: 'runtime.status', outcome: 'allowed', detail: 'read' });
    expect(trail.list()).toHaveLength(1);
    const health = healthSnapshot([]);
    expect(JSON.stringify(health)).not.toContain('MOHO_MYSQL_URL');
  });
});
