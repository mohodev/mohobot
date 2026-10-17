/**
 * Plugin-side smoke test for the compatibility shims.
 *
 * The operator registry and tool implementations moved to src/operator/ (the
 * single source of truth shared by this plugin, the ACP server and the admin
 * WebUI); full behavior coverage lives in src/operator/*.test.ts and runs under
 * the root vitest config. This file only proves the shim re-exports the same
 * module instances the rest of the runtime uses.
 */

import { describe, expect, it } from 'vitest';

import * as srcRegistry from '../../src/operator/registry.js';
import * as srcTools from '../../src/operator/tools.js';
import * as shimRegistry from './registry.js';
import * as shimTools from './tools.js';

describe('operator shims', () => {
  it('re-export the exact registry bindings from src/operator', () => {
    expect(shimRegistry.authorize).toBe(srcRegistry.authorize);
    expect(shimRegistry.stage).toBe(srcRegistry.stage);
    expect(shimRegistry.consume).toBe(srcRegistry.consume);
    expect(shimRegistry.readAudit).toBe(srcRegistry.readAudit);
    expect(shimRegistry.getProcessBootId).toBe(srcRegistry.getProcessBootId);
  });

  it('re-export the exact tool list from src/operator', () => {
    expect(shimTools.operatorTools).toBe(srcTools.operatorTools);
    expect(shimTools.operatorTools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['diag', 'patch', 'config', 'restart', 'git', 'verify']),
    );
  });

  it('staged confirmations through the shim are consumable in this process', async () => {
    const store = new Map<string, unknown>();
    const storage = {
      async get<T>(key: string) { return store.get(key) as T | undefined; },
      async save<T>(key: string, value: T) { store.set(key, value); },
      async delete(key: string) { store.delete(key); },
      async query() { return []; },
    };
    const code = await shimRegistry.stage({ storage }, 'verify', ['typecheck'], 'admin-1');
    const result = await shimRegistry.consume({ storage }, code, 'admin-1', 300_000);
    expect(result.request).toMatchObject({ tool: 'verify', caller: 'admin-1', bootId: srcRegistry.getProcessBootId() });
  });
});
