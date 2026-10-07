/**
 * Hermetic test environment.
 *
 * Runtime code resolves its state directory from `MOHO_ROOT ?? process.cwd()`
 * (chat log database, World/Device stores, ...). Without this, any test that
 * drives the pipeline writes into the repository's real `data/` - including the
 * production SQLite chat log when `npm test` runs inside a deployment (as
 * `npm run update` does) - and several parallel workers end up sharing one WAL
 * database file. Every test file therefore gets its own throwaway root.
 *
 * Tests that need a specific root still pass an explicit one (`stateRoot`,
 * `rootDir`) or set MOHO_ROOT themselves.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

const previous = process.env['MOHO_ROOT'];
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mohobot-test-root-'));
process.env['MOHO_ROOT'] = root;

function cleanup(): void {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  if (previous === undefined) delete process.env['MOHO_ROOT'];
  else process.env['MOHO_ROOT'] = previous;
}

// `process.on('exit')` never fires in vitest's worker processes (they are torn
// down by the pool), which leaked one directory per test file. afterAll does run.
afterAll(cleanup);
process.once('exit', cleanup);
