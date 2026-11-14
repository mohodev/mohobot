import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// React Testing Library does not auto-clean without the global afterEach hook
// (globals are disabled here), so register it once for every test file.
afterEach(() => {
  cleanup();
});
