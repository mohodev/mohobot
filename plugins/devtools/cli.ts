/**
 * devtools CLI - debug the AI path without booting the bot.
 *
 *   npx tsx plugins/devtools/cli.ts list
 *   npx tsx plugins/devtools/cli.ts chat   --provider mock --prompt "hello"
 *   npx tsx plugins/devtools/cli.ts stream --provider mock --prompt "hello"
 *   npx tsx plugins/devtools/cli.ts probe  --provider mock
 *
 * It deliberately reuses the runtime's real assembly path - load
 * `extensions/*.ts`, resolve config through ConfigLoader, pull the provider
 * out of the registry - so what you see here is what the bot would do. There
 * is no second HTTP client hiding in this file.
 *
 * This is the one place in the plugin where writing to stdout is correct: the
 * output IS the product. Everything goes through process.stdout.write, never
 * console.log, and every credential passes through the redaction helpers.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { createProvider } from '../../src/ai/index.js';
import type { AIProvider, AIResponse } from '../../src/ai/types.js';
import { ConfigLoader } from '../../src/config/loader.js';
import type { AIConfig, ResolvedBotConfig, ResolvedConfig } from '../../src/config/schema.js';
import { createLogger, createNullLogger, registerSecret, type Logger } from '../../src/core/logger.js';
import { registries } from '../../src/core/registries.js';
// Side-effect imports: these register the built-in gateways, storage drivers
// and memory adapters, exactly as importing them from src/index.ts does.
import '../../src/discord/index.js';
import '../../src/storage/index.js';
import { describeError, requestPreview } from './commands.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** plugins/devtools -> project root */
const ROOT_DIR = process.env['MOHO_ROOT'] ?? path.resolve(HERE, '../..');

function out(text: string): void {
  process.stdout.write(text);
}
function line(text = ''): void {
  out(`${text}\n`);
}

const USAGE = `mohobot devtools CLI

usage: npx tsx plugins/devtools/cli.ts <command> [options]

commands:
  list                       show every registered provider / gateway / storage / memory
  chat                       one AI request, prints reply + finish reason + usage + elapsed
  stream                     same as chat but prints deltas as they arrive
  probe                      call provider.health() and report the result

options:
  --provider <name>          registered provider name (default: the bot's configured one)
  --model <name>             override the model
  --prompt <text>            prompt text (chat/stream); positional text also works
  --bot <id>                 which bot config to borrow settings from (default: first)
  --timeout <ms>             override request timeout
  --show-headers             print the (redacted) request headers
  --json                     machine-readable output
  --verbose                  show runtime logs instead of staying quiet
  -h, --help                 this text

no API key configured? the framework falls back to the offline 'mock'
provider, so every command above works with zero credentials.
`;

interface CliOptions {
  provider?: string;
  model?: string;
  prompt?: string;
  bot?: string;
  timeout?: string;
  showHeaders: boolean;
  json: boolean;
  verbose: boolean;
  help: boolean;
  positionals: string[];
}

function parse(argv: string[]): CliOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      provider: { type: 'string' },
      model: { type: 'string' },
      prompt: { type: 'string' },
      bot: { type: 'string' },
      timeout: { type: 'string' },
      'show-headers': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  return {
    provider: values.provider,
    model: values.model,
    prompt: values.prompt,
    bot: values.bot,
    timeout: values.timeout,
    showHeaders: values['show-headers'] === true,
    json: values.json === true,
    verbose: values.verbose === true,
    help: values.help === true,
    positionals,
  };
}

/**
 * Mirror of Runtime#loadExtensions in src/index.ts: import every
 * `extensions/*.ts` and hand it the registries. A broken extension is skipped,
 * never fatal.
 */
async function loadExtensions(logger: Logger): Promise<string[]> {
  const dir = path.join(ROOT_DIR, 'extensions');
  let entries: string[];
  try {
    entries = (await fs.readdir(dir)).filter((f) => /\.(ts|js|mjs)$/.test(f) && !f.endsWith('.d.ts')).sort();
  } catch {
    return [];
  }

  const loaded: string[] = [];
  for (const file of entries) {
    const full = path.join(dir, file);
    try {
      const mod: unknown = await import(pathToFileURL(full).href);
      const register =
        (mod as { register?: unknown; default?: unknown }).register ?? (mod as { default?: unknown }).default;
      if (typeof register === 'function') {
        await (register as (r: typeof registries, l: Logger) => unknown)(registries, logger);
      }
      loaded.push(file);
    } catch (error) {
      line(`warn: extension ${file} failed to load (skipped): ${describeError(error)}`);
    }
  }
  return loaded;
}

async function loadConfig(logger: Logger): Promise<ResolvedConfig> {
  const config = await new ConfigLoader({ rootDir: ROOT_DIR, logger }).load();
  // Register every secret before anything is printed.
  registerSecret(config.global.ai.apiKey);
  for (const bot of config.bots) {
    registerSecret(bot.ai.apiKey);
    registerSecret(bot.discord.token);
  }
  return config;
}

function pickBot(config: ResolvedConfig, id: string | undefined): ResolvedBotConfig {
  if (id === undefined) {
    const first = config.bots[0];
    if (!first) throw new Error('no bots defined in config/bots/*.yaml');
    return first;
  }
  const found = config.bots.find((b) => b.id === id);
  if (!found) {
    throw new Error(`unknown bot "${id}". Available: ${config.bots.map((b) => b.id).join(', ') || '(none)'}`);
  }
  return found;
}

function buildAiConfig(bot: ResolvedBotConfig, opts: CliOptions): AIConfig {
  const ai: AIConfig = { ...bot.ai };
  if (opts.model !== undefined && opts.model.trim().length > 0) ai.model = opts.model.trim();
  if (opts.provider !== undefined && opts.provider.trim().length > 0) ai.provider = opts.provider.trim().toLowerCase();
  if (opts.timeout !== undefined) {
    const ms = Number.parseInt(opts.timeout, 10);
    if (Number.isFinite(ms) && ms > 0) ai.timeoutMs = ms;
  }
  return ai;
}

/**
 * Explicit `--provider` goes straight to the registry, so you can exercise a
 * provider the bot is not configured for. Without it, the runtime's own
 * selection logic runs - including the automatic mock fallback.
 */
function resolveProvider(opts: CliOptions, ai: AIConfig, logger: Logger): AIProvider {
  const requested = opts.provider?.trim().toLowerCase();
  if (requested === undefined || requested.length === 0) {
    return createProvider(ai, { logger });
  }
  const factory = registries.providers.get(requested);
  if (factory === undefined) {
    throw new Error(
      `unknown provider "${requested}". Registered: ${registries.providers.names().join(', ') || '(none)'}`,
    );
  }
  return factory({ ...ai, provider: requested }, { logger });
}

function promptFrom(opts: CliOptions): string {
  const fromFlag = opts.prompt?.trim() ?? '';
  if (fromFlag.length > 0) return fromFlag;
  return opts.positionals.slice(1).join(' ').trim();
}

function usageLine(response: AIResponse): string {
  const u = response.usage;
  if (!u) return 'usage    : n/a';
  return `usage    : prompt ${u.promptTokens ?? 0} / completion ${u.completionTokens ?? 0} / total ${u.totalTokens ?? 0}`;
}

function printHeaders(ai: AIConfig): void {
  line('headers  :');
  for (const [key, value] of Object.entries(requestPreview(ai))) {
    line(`  ${key}: ${value}`);
  }
}

// ------------------------------------------------------------------ commands

async function runList(opts: CliOptions, logger: Logger): Promise<void> {
  const extensions = await loadExtensions(logger);
  const config = await loadConfig(logger);

  if (opts.json) {
    const dump = {
      extensions,
      providers: registries.providers.list().map(({ name, source, description }) => ({ name, source, description })),
      gateways: registries.gateways.list().map(({ name, source, description }) => ({ name, source, description })),
      storages: registries.storages.list().map(({ name, source, description }) => ({ name, source, description })),
      memories: registries.memories.list().map(({ name, source, description }) => ({ name, source, description })),
      bots: config.bots.map((b) => ({ id: b.id, adapter: b.adapter, provider: b.ai.provider, model: b.ai.model })),
    };
    line(JSON.stringify(dump, null, 2));
    return;
  }

  const section = (label: string, entries: { name: string; source: string; description?: string }[]): void => {
    line(`${label} (${entries.length})`);
    if (entries.length === 0) {
      line('  (none)');
      return;
    }
    for (const entry of entries.slice().sort((a, b) => a.name.localeCompare(b.name))) {
      line(`  ${entry.name.padEnd(20)} source=${entry.source}${entry.description ? ` - ${entry.description}` : ''}`);
    }
  };

  line(`root       : ${ROOT_DIR}`);
  line(`extensions : ${extensions.length > 0 ? extensions.join(', ') : '(none)'}`);
  line();
  section('providers', registries.providers.list());
  section('gateways', registries.gateways.list());
  section('storages', registries.storages.list());
  section('memories', registries.memories.list());
  line();
  line(`bots (${config.bots.length})`);
  for (const bot of config.bots) {
    line(`  ${bot.id.padEnd(20)} adapter=${bot.adapter} provider=${bot.ai.provider} model=${bot.ai.model}`);
  }
}

async function runChat(opts: CliOptions, logger: Logger, stream: boolean): Promise<void> {
  const prompt = promptFrom(opts);
  if (prompt.length === 0) {
    line('error: a prompt is required, e.g. --prompt "hello"');
    process.exitCode = 1;
    return;
  }

  await loadExtensions(logger);
  const config = await loadConfig(logger);
  const bot = pickBot(config, opts.bot);
  const ai = buildAiConfig(bot, opts);
  const provider = resolveProvider(opts, ai, logger);

  let streamed = '';
  const started = Date.now();
  let response: AIResponse;
  try {
    if (stream) line('--- stream ---');
    response = await provider.chat([{ role: 'user', content: prompt }], {
      model: ai.model,
      temperature: ai.temperature,
      maxTokens: ai.maxTokens,
      timeoutMs: ai.timeoutMs,
      ...(stream
        ? {
            stream: true,
            onDelta: (delta: string) => {
              streamed += delta;
              out(delta);
            },
          }
        : {}),
    });
  } catch (error) {
    if (stream) line();
    line(`error: ${describeError(error)}`);
    process.exitCode = 1;
    return;
  }
  const elapsed = Date.now() - started;

  if (opts.json) {
    line(
      JSON.stringify(
        {
          provider: provider.name,
          model: response.model,
          prompt,
          reply: response.content,
          finishReason: response.finishReason,
          usage: response.usage,
          elapsedMs: elapsed,
          providerMs: response.ms,
          streamedChars: stream ? streamed.length : undefined,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (stream) {
    line();
    line('--- meta ---');
    line(`deltas   : ${streamed.length} chars streamed`);
    line(`provider : ${provider.name}`);
    line(`model    : ${response.model}`);
  } else {
    line(`provider : ${provider.name}`);
    line(`model    : ${response.model}`);
    line(`prompt   : ${prompt}`);
    line('--- reply ---');
    line(response.content);
    line('--- meta ---');
  }
  line(`finish   : ${response.finishReason ?? 'n/a'}`);
  line(usageLine(response));
  line(`elapsed  : ${elapsed}ms (provider reported ${response.ms}ms)`);
  if (opts.showHeaders) printHeaders(ai);
}

async function runProbe(opts: CliOptions, logger: Logger): Promise<void> {
  await loadExtensions(logger);
  const config = await loadConfig(logger);
  const bot = pickBot(config, opts.bot);
  const ai = buildAiConfig(bot, opts);
  const provider = resolveProvider(opts, ai, logger);

  const started = Date.now();
  let result: { ok: boolean; detail?: string };
  try {
    result = await provider.health();
  } catch (error) {
    // health() must not throw; if it does, that is itself the finding.
    result = { ok: false, detail: `health() threw: ${describeError(error)}` };
  }
  const elapsed = Date.now() - started;

  if (opts.json) {
    line(JSON.stringify({ provider: provider.name, model: provider.model, ...result, elapsedMs: elapsed }, null, 2));
  } else {
    line(`provider : ${provider.name}`);
    line(`model    : ${provider.model}`);
    line(`health   : ${result.ok ? 'OK' : 'FAILED'}`);
    line(`detail   : ${result.detail ?? '(none)'}`);
    line(`elapsed  : ${elapsed}ms`);
    if (opts.showHeaders) printHeaders(ai);
  }
  if (!result.ok) process.exitCode = 1;
}

async function main(): Promise<void> {
  let opts: CliOptions;
  try {
    opts = parse(process.argv.slice(2));
  } catch (error) {
    line(`error: ${describeError(error)}`);
    line();
    out(USAGE);
    process.exitCode = 1;
    return;
  }

  const command = opts.positionals[0] ?? 'help';
  if (opts.help || command === 'help') {
    out(USAGE);
    return;
  }

  // Quiet by default: the CLI output is the product, runtime logs are noise.
  const logger = opts.verbose ? createLogger({ name: 'devtools-cli', level: 'debug' }) : createNullLogger();

  try {
    switch (command) {
      case 'list':
        await runList(opts, logger);
        break;
      case 'chat':
        await runChat(opts, logger, false);
        break;
      case 'stream':
        await runChat(opts, logger, true);
        break;
      case 'probe':
        await runProbe(opts, logger);
        break;
      default:
        line(`error: unknown command "${command}"`);
        line();
        out(USAGE);
        process.exitCode = 1;
    }
  } catch (error) {
    line(`error: ${describeError(error)}`);
    process.exitCode = 1;
  }
}

await main();
