// Vitest config for this plugin only.
//
// The root vitest.config.ts only globs test files under src/, which does not
// reach plugins/. Rather than edit shared config (the task forbids touching
// src/ and the point is that a plugin is self-contained), this config lives
// inside the plugin. Run it from the plugin directory:
//
//   cd plugins/kilo-provider && npx vitest run

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
