import { describe, expect, it } from 'vitest';

import { McpToolPolicy, defaultPolicy } from './permissions.js';
import type { McpCaller, McpRole } from './types.js';

function caller(role: McpRole, id = 'u1'): McpCaller {
  return { id, role };
}

describe('MCP tool policy', () => {
  it('denies tools not covered by the policy, even for developer (fail closed)', () => {
    const decision = defaultPolicy.authorize('rm.everything', caller('developer'));
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain('default deny');
  });

  it('lets every role call read-only tools', () => {
    for (const role of ['viewer', 'operator', 'admin', 'developer'] as const) {
      const decision = defaultPolicy.authorize('search.web', caller(role));
      expect(decision.allow).toBe(true);
      expect(decision.reason).toContain('allowed');
    }
  });

  it('denies the write tool for viewer and operator, allows admin and developer', () => {
    expect(defaultPolicy.authorize('config.set', caller('viewer')).allow).toBe(false);
    expect(defaultPolicy.authorize('config.set', caller('operator')).allow).toBe(false);
    expect(defaultPolicy.authorize('config.set', caller('admin')).allow).toBe(true);
    expect(defaultPolicy.authorize('config.set', caller('developer')).allow).toBe(true);
  });

  it('explains denials with the required role', () => {
    const decision = defaultPolicy.authorize('config.set', caller('viewer'));
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain("requires role 'admin'");
    expect(decision.reason).toContain("caller is 'viewer'");
  });

  it('matches prefix patterns', () => {
    expect(defaultPolicy.authorize('system.reboot', caller('operator')).allow).toBe(false);
    expect(defaultPolicy.authorize('system.reboot', caller('admin')).allow).toBe(true);
  });

  it('prefers an exact-name rule over a pattern', () => {
    const policy = new McpToolPolicy([
      { pattern: 'system.*', minRole: 'admin' },
      { pattern: 'system.status', minRole: 'viewer' },
    ]);
    expect(policy.authorize('system.status', caller('viewer')).allow).toBe(true);
    expect(policy.authorize('system.reboot', caller('viewer')).allow).toBe(false);
  });

  it('denies callers without identity or with an unknown role', () => {
    expect(defaultPolicy.authorize('search.web', undefined).allow).toBe(false);
    expect(defaultPolicy.authorize('search.web', { id: '', role: 'viewer' }).allow).toBe(false);
    const forged = { id: 'u1', role: 'superuser' } as unknown as McpCaller;
    const decision = defaultPolicy.authorize('search.web', forged);
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain('unknown caller role');
  });
});
