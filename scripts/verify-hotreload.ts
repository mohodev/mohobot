/**
 * Throwaway smoke test: does plugin hot reload actually work under the real
 * Node/tsx runtime (not vitest's module runner)?
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventBus } from '../src/core/event.js';
import { createNullLogger } from '../src/core/logger.js';
import { PluginManager } from '../src/plugins/manager.js';
import type { MohoMessage } from '../src/core/types.js';

const msg: MohoMessage = {
  id: 'm1',
  platform: 'console',
  botId: 'main',
  channel: { id: 'c1', dm: true },
  author: { id: 'u1', username: 't', bot: false },
  content: 'x',
  mentionsBot: true,
  attachments: [],
  createdAt: Date.now(),
};

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moho-hr-'));
const write = async (id: string, src: string) => {
  await fs.mkdir(path.join(dir, id), { recursive: true });
  await fs.writeFile(path.join(dir, id, 'index.ts'), src, 'utf8');
};

const pm = new PluginManager({
  dir,
  logger: createNullLogger(),
  events: new EventBus(),
  hookTimeoutMs: 500,
  maxErrors: 3,
  allow: [],
  deny: [],
  send: async () => {},
});

await write('ver', `export default { name: 'ver', onMessage() { return { reply: 'v1' }; } };`);
await pm.loadAll();
const first = (await pm.runMessageHooks(msg)).reply;

await write('ver', `export default { name: 'ver', onMessage() { return { reply: 'v2' }; } };`);
const reloadOk = await pm.load('ver');
const second = (await pm.runMessageHooks(msg)).reply;

await write('ver', `export default { name: 'ver', ??? }`);
const brokenOk = await pm.load('ver');
const third = (await pm.runMessageHooks(msg)).reply;

console.log(JSON.stringify({ first, reloadOk, second, brokenOk, third }, null, 2));
console.log(
  first === 'v1' && reloadOk && second === 'v2' && brokenOk === false && third === 'v2'
    ? 'HOTRELOAD_OK'
    : 'HOTRELOAD_FAIL',
);
await fs.rm(dir, { recursive: true, force: true });
