/**
 * Regression guard: better-sqlite3 must survive garbage collection of many
 * prepared statements.
 *
 * better-sqlite3 11.x aborted the whole process on Node 24 when GC finalized a
 * Statement (`Assertion failed: (env) != nullptr` inside
 * RemoveEnvironmentCleanupHook). This codebase prepares a statement per call in
 * src/storage/{sqlite,chatlog,migrations}.ts, so the failure showed up as a
 * random "Worker exited unexpectedly" in an unrelated test file and as a latent
 * crash in the live bot. It cannot be caught in-process, so the workload runs
 * in a child with --expose-gc and we assert on its exit status.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const moduleDir = path.resolve(import.meta.dirname, '..', '..', 'node_modules', 'better-sqlite3');

const WORKLOAD = `
const Database = require(process.argv[1]);
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-gc-'));
try {
  const db = new Database(path.join(dir, 't.db'));
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)');
  for (let i = 1; i <= 60000; i += 1) {
    db.prepare('INSERT INTO t (v) VALUES (?)').run('x'.repeat(i % 100));   // a new Statement per call, like chatLogInsert
    if (i % 4000 === 0) global.gc();                                        // force finalizers to run
  }
  const n = db.prepare('SELECT COUNT(*) AS c FROM t').get().c;
  db.close();
  process.stdout.write('ROWS=' + n);
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
`;

describe('better-sqlite3 under statement GC pressure', () => {
  it('does not abort the process when prepared statements are garbage collected', () => {
    const result = spawnSync(process.execPath, ['--expose-gc', '-e', WORKLOAD, moduleDir], { encoding: 'utf8', timeout: 90_000 });
    // Include the native message in the failure output: it names the exact assertion.
    expect({ status: result.status, signal: result.signal, out: result.stdout.trim(), err: result.stderr.slice(0, 400) })
      .toEqual({ status: 0, signal: null, out: 'ROWS=60000', err: '' });
  }, 100_000);
});
