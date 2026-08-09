/**
 * Vitest project for plugins/devtools.
 *
 * The root vitest.config.ts only includes `src/**\/*.test.ts`, and that file is
 * shared with other in-flight work, so this plugin ships its own config rather
 * than editing it.
 *
 *   npx vitest run --config plugins/devtools/vitest.config.ts
 */

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
