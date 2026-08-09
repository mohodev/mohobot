// Vitest config for plugins/model-catalog.
//
// The root vitest config only globs test files under src/, and this plugin
// must not modify anything outside its own directory - so it ships its own
// config.
//
//   cd plugins/model-catalog && npx vitest run
//
// Paths are relative to the plugin directory (root is set below), which keeps
// the plugin's imports of ../../src resolvable.

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['**/*.test.ts'],
    environment: 'node',
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
