import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * The dashboard test suite runs two kinds of tests in one process:
 *  - pure lib/API tests (fetch + storage stubs),
 *  - component/hook tests rendered into jsdom via @testing-library/react.
 *
 * jsdom satisfies both, so a single environment keeps the config simple and
 * gives every page test the same DOM baseline. The setup file installs the
 * matchers and polyfills the shared contract assumes.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    restoreMocks: true,
    clearMocks: true,
  },
});
