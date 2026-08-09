/**
 * THE EXTENSIBILITY PROOF.
 *
 * Boots the real runtime wiring with ONLY config changes + the demo extension,
 * and asserts that a third-party AI provider, gateway, storage driver and
 * long-term memory adapter all take effect.
 *
 * If this passes while `src/` stays byte-identical, extension-without-
 * modification is demonstrated rather than asserted.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRegistries } from '../src/core/registries.js';
import { registerBuiltinProviders, createProvider } from '../src/ai/index.js';
import { registerBuiltinGateways } from '../src/discord/index.js';
import { registerBuiltinStorage, createStorage } from '../src/storage/index.js';
import { createLogger } from '../src/core/logger.js';
import { EventBus } from '../src/core/event.js';
import { SessionManager } from '../src/session/manager.js';
import {
  AIConfigSchema,
  BotConfigSchema,
  MemoryConfigSchema,
  SessionConfigSchema,
  StorageConfigSchema,
  type ResolvedBotConfig,
} from '../src/config/schema.js';
import { register as registerDemo, WebhookGateway } from '../extensions/demo-extension.js';

const logger = createLogger({ level: 'warn', pretty: false });
const results: string[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  return ok;
};

function resolveBot(overrides: Record<string, unknown>): ResolvedBotConfig {
  const base = BotConfigSchema.parse({ id: 'main', ...overrides });
  return {
    ...base,
    ai: AIConfigSchema.parse(base.ai),
    session: SessionConfigSchema.parse(base.session),
    memory: MemoryConfigSchema.parse(base.memory),
  };
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moho-ext-'));

// A registry set exactly like the runtime's: built-ins, then the extension.
const registries = createRegistries();
registerBuiltinProviders();
registerBuiltinGateways();
registerBuiltinStorage();
// Re-register built-ins into this isolated set (module-level ones went global).
const { registries: globalRegs } = await import('../src/core/registries.js');
for (const kind of ['providers', 'gateways', 'storages', 'memories'] as const) {
  for (const entry of globalRegs[kind].list()) {
    (registries[kind] as { register: Function }).register(entry.name, entry.factory, {
      source: entry.source,
      override: true,
    });
  }
}

const builtinCounts = {
  providers: registries.providers.names(),
  gateways: registries.gateways.names(),
  storages: registries.storages.names(),
  memories: registries.memories.names(),
};

registerDemo(registries, logger);

// ---- 1. new AI provider selected purely by config ----
const aiCfg = AIConfigSchema.parse({ provider: 'echo-upper', apiKey: 'x', model: 'demo-model' });
const provider = createProviderFrom(aiCfg);
function createProviderFrom(cfg: typeof aiCfg) {
  const factory = registries.providers.require(cfg.provider);
  return factory(cfg, { logger });
}
const aiReply = await provider.chat([{ role: 'user', content: 'hello extension' }], {});
check('new AI provider via config', aiReply.content === 'HELLO EXTENSION', `-> "${aiReply.content}"`);

// ---- 2. new gateway selected purely by config ----
const botCfg = resolveBot({ adapter: 'webhook' });
const gateway = registries.gateways.require(botCfg.adapter)(botCfg, { events: new EventBus(), logger });
await gateway.start();
const inbound: string[] = [];
gateway.onMessage((m) => void inbound.push(m.content));
await (gateway as WebhookGateway).inject('ping from webhook');
await gateway.send({ channelId: 'hook', content: 'reply out' });
check(
  'new gateway via config',
  gateway.platform === 'webhook' && inbound[0] === 'ping from webhook',
  `platform=${gateway.platform} inbound=${JSON.stringify(inbound)}`,
);
await gateway.stop();

// ---- 3. new storage driver selected purely by config ----
const storageCfg = StorageConfigSchema.parse({ driver: 'jsonl', path: './store.db' });
const storage = registries.storages.require(storageCfg.driver)(storageCfg, { rootDir: tmp, logger });
await storage.init();
await storage.save('k1', { hello: 'jsonl' });
const roundTrip = await storage.get<{ hello: string }>('k1');
const jsonlOnDisk = await fs.readFile(path.join(tmp, 'store.jsonl'), 'utf8');
check(
  'new storage driver via config',
  roundTrip?.hello === 'jsonl' && jsonlOnDisk.includes('"hello":"jsonl"'),
  `file=${jsonlOnDisk.trim().slice(0, 60)}`,
);

// ---- 4. long-term memory adapter, end to end through SessionManager ----
const memCfg = MemoryConfigSchema.parse({ adapter: 'keyword' });
const memory = registries.memories.require(memCfg.adapter)({
  botId: 'main',
  logger,
  storage,
  options: memCfg.options,
});
const sessions = new SessionManager({
  botId: 'main',
  config: SessionConfigSchema.parse({}),
  storage,
  logger,
  memory,
});
const key = { botId: 'main', channelId: 'hook', userId: 'caller' };
await sessions.append(key, { role: 'user', content: 'my name is Pi' });
await sessions.completeExchange(
  key,
  { role: 'user', content: 'my name is Pi' },
  { role: 'assistant', content: 'noted' },
);
await sessions.flush();

await sessions.clear(key);
const ctx = await sessions.buildContext(key, 'SYSTEM');
const recalled = ctx.some((m) => m.content.includes('name=Pi'));
check('long-term memory recall after context cleared', recalled, `context=${JSON.stringify(ctx.map((m) => m.content))}`);

// ---- 5. plugin-registered entries are reaped on unload ----
registries.providers.register('temp-plugin-provider', (cfg) => provider, { source: 'plugin:temp' });
const before = registries.providers.has('temp-plugin-provider');
const reaped = registries.providers.unregisterSource('plugin:temp');
check(
  'plugin extensions reaped on unload',
  before && !registries.providers.has('temp-plugin-provider') && reaped.includes('temp-plugin-provider'),
  `reaped=${JSON.stringify(reaped)}`,
);

// ---- 6. built-ins untouched by the extension ----
check(
  'built-ins still present',
  builtinCounts.providers.includes('openai-compatible') && registries.gateways.has('discord') && registries.storages.has('sqlite'),
  `providers=${registries.providers.names().join(',')} gateways=${registries.gateways.names().join(',')}`,
);

await storage.close();
await fs.rm(tmp, { recursive: true, force: true });

console.log(results.join('\n'));
console.log(results.every((r) => r.startsWith('PASS')) ? '\nEXTENSIBILITY_PROVEN' : '\nEXTENSIBILITY_FAILED');
