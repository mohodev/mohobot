import type { ReactElement } from 'react';
import { render, type RenderOptions } from '@testing-library/react';

/**
 * Re-exports `render` with the dashboard's default options applied, so every
 * page test shares one entry point. Pages have no global providers today, but
 * routing them through here keeps a single migration point if one is added.
 */
export function renderWithProviders(ui: ReactElement, options?: Omit<RenderOptions, 'wrapper'>) {
  return render(ui, options);
}

export * from '@testing-library/react';
