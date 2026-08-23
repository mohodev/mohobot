#!/usr/bin/env node
/**
 * Production entry point. Run exactly: `node app.js`.
 *
 * TypeScript is compiled before launch. MOHO_COMPILED makes the Runtime load
 * compiled plugins from dist/plugins rather than source .ts files.
 */
process.env.MOHO_COMPILED = '1';
const { Runtime } = await import('./dist/src/index.js');
const runtime = new Runtime();
runtime.boot().catch((error) => {
  console.error('[mohobot] fatal boot error:', error instanceof Error ? error.stack : error);
  process.exit(1);
});
