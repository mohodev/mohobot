import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';

export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true });
  const temp = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(temp, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temp, file);
    const directoryHandle = await fs.open(directory, 'r');
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}
