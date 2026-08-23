import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const tsc = process.platform === 'win32' ? 'npx.cmd' : 'npx';

await rm(dist, { recursive: true, force: true });
const compiled = spawnSync(tsc, ['tsc', '-p', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit' });
if (compiled.status !== 0) process.exit(compiled.status ?? 1);

const pluginsDir = path.join(root, 'plugins');
for (const entry of await readdir(pluginsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const source = path.join(pluginsDir, entry.name, 'plugin.json');
  const target = path.join(dist, 'plugins', entry.name, 'plugin.json');
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
