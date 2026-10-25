import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSetup } from '../src/setup.js';

export { runSetup } from '../src/setup.js';
export type { SetupOptions, SetupResult } from '../src/setup.js';

function hasFlag(args: string[], flag: string): boolean { return args.includes(flag); }

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const nonInteractive = hasFlag(process.argv.slice(2), '--non-interactive');
  const force = hasFlag(process.argv.slice(2), '--force');
  runSetup({ nonInteractive, force })
    .then((result) => {
      console.log(`MohoBot setup complete: ${result.rootDir}`);
      console.log(`.env.local: ${result.envCreated ? 'created' : 'kept existing'}`);
      console.log(`SQLite: ${result.sqlitePath}`);
      if (result.envCreated) console.log('MOHO_ADMIN_TOKEN generated and stored in .env.local (not printed).');
    })
    .catch((error: unknown) => { console.error(`MohoBot setup failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
}
