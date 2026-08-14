/**
 * ConfigLoader behaviour: defaults, inheritance, env precedence, fault tolerance.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EventBus } from '../core/event.js';
import { createNullLogger } from '../core/logger.js';
import { ConfigLoader, parseEnvFile } from './loader.js';

const logger = createNullLogger();

const ENV_KEYS = [
  'LOG_LEVEL',
  'DISCORD_TOKEN',
  'AI_API_KEY',
  'AI_BASE_URL',
  'AI_MODEL',
  'MOHO_ADAPTER',
  'MOHO_STORAGE_PATH',
  'MOHO_BOT_MAIN_DISCORD_TOKEN',
  'MOHO_BOT_MAIN_AI_MODEL',
  'MOHO_BOT_MAIN_AI_API_KEY',
  'MOHO_BOT_MAIN_AI_BASE_URL',
  'VISION_SECRET',
  'OCR_SECRET',
  'NVIDIA_API_KEY',
  'NVIDIA_NIM_API_KEY',
];

let rootDir = '';
let savedEnv: Record<string, string | undefined> = {};

async function writeGlobal(body: string): Promise<void> {
  await mkdir(path.join(rootDir, 'config'), { recursive: true });
  await writeFile(path.join(rootDir, 'config', 'global.yaml'), body, 'utf8');
}

async function writeBot(name: string, body: string): Promise<void> {
  await mkdir(path.join(rootDir, 'config', 'bots'), { recursive: true });
  await writeFile(path.join(rootDir, 'config', 'bots', name), body, 'utf8');
}

function newLoader(events?: EventBus): ConfigLoader {
  return events ? new ConfigLoader({ rootDir, logger, events }) : new ConfigLoader({ rootDir, logger });
}

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(os.tmpdir(), 'mohobot-config-'));
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(rootDir, { recursive: true, force: true });
});

describe('parseEnvFile', () => {
  it('handles comments, quotes and inline comments', () => {
    const parsed = parseEnvFile(
      ['# a comment', '', 'AI_MODEL=deepseek-chat', 'QUOTED="hello world"', "SINGLE='x y'", 'ADAPTER=console   # trailing'].join('\n'),
    );
    expect(parsed).toEqual({
      AI_MODEL: 'deepseek-chat',
      QUOTED: 'hello world',
      SINGLE: 'x y',
      ADAPTER: 'console',
    });
  });
});

describe('ConfigLoader', () => {
  it('fills in schema defaults and derives the bot id from the filename', async () => {
    await writeGlobal('logLevel: debug\n');
    await writeBot('main.yaml', 'name: Main\n');

    const cfg = await newLoader().load();

    expect(cfg.global.logLevel).toBe('debug');
    expect(cfg.global.storage.driver).toBe('sqlite');
    expect(cfg.global.supervisor.autoRestart).toBe(true);
    expect(cfg.bots).toHaveLength(1);

    const bot = cfg.bots[0];
    expect(bot?.id).toBe('main');
    expect(bot?.name).toBe('Main');
    expect(bot?.enabled).toBe(true);
    expect(bot?.adapter).toBe('discord');
    expect(bot?.ai.model).toBe('gpt-4o-mini');
    expect(bot?.ai.baseUrl).toBe('https://api.openai.com/v1');
    expect(bot?.ai.maxTokens).toBe(1024);
    expect(bot?.session.maxMessages).toBe(20);
    expect(bot?.session.scope).toBe('user');
    expect(bot?.discord.maxReplyLength).toBe(1900);
    expect(cfg.rootDir).toBe(path.resolve(rootDir));
  });

  it('resolves an opt-in administrator bot allowlist', async () => {
    await writeBot('main.yaml', ['name: 墨染荷韵', 'admin:', '  enabled: true', '  userIds:', '    - "123"', ''].join('\n'));
    const cfg = await newLoader().load();
    expect(cfg.bots[0]?.admin).toEqual({ enabled: true, userIds: ['123'] });
  });

  it('keeps legacy tracked-only fixtures working unchanged', async () => {
    await writeGlobal(['version: 1', 'logLevel: debug', 'session:', '  maxMessages: 7', ''].join('\n'));
    await writeBot('legacy.yaml', ['name: Legacy', 'session:', '  scope: channel', ''].join('\n'));
    const cfg = await newLoader().load();
    expect(cfg.global.version).toBe(1);
    expect(cfg.global.session.maxMessages).toBe(7);
    expect(cfg.bots[0]).toMatchObject({ id: 'legacy', name: 'Legacy' });
    expect(cfg.bots[0]).not.toHaveProperty('version');
    expect(cfg.bots[0]?.session.scope).toBe('channel');
  });

  it('maps legacy multi-provider fields into options with new options winning', async () => {
    await writeGlobal(['ai:','  profiles:','    old: { baseUrl: https://old.example, model: old }','  defaultProfile: old','  budget: { rpm: 5 }','  options:','    defaultProfile: newer','    budget: { concurrency: 2 }',''].join('\n'));
    const ai = (await newLoader().load()).global.ai;
    expect(ai.options).toMatchObject({ profiles:{old:{model:'old'}}, defaultProfile:'newer', budget:{rpm:5,concurrency:2} });
  });

  it('uses canonical NVIDIA_NIM_API_KEY before NVIDIA_API_KEY alias', async () => {
    await writeGlobal('ai:\n  apiKey: yaml\n');
    process.env['NVIDIA_API_KEY']='alias'; process.env['NVIDIA_NIM_API_KEY']='canonical';
    expect((await newLoader().load()).global.ai.apiKey).toBe('canonical');
  });

  it('reloads an isolated env snapshot without mutating process.env', async () => {
    await writeGlobal('logLevel: info\n');
    await writeFile(path.join(rootDir, '.env.local'), 'AI_MODEL=file-one\nSNAPSHOT_ONLY=present\n');
    const loader = newLoader();
    expect((await loader.load()).global.ai.model).toBe('file-one');
    expect(process.env['SNAPSHOT_ONLY']).toBeUndefined();
    await writeFile(path.join(rootDir, '.env.local'), 'AI_MODEL=file-two\n');
    expect((await loader.reload()).global.ai.model).toBe('file-two');
    expect(process.env['SNAPSHOT_ONLY']).toBeUndefined();
    await rm(path.join(rootDir, '.env.local'));
    expect((await loader.reload()).global.ai.model).not.toBe('file-two');
  });

  it('deep-merges global, bot and provider local overrides without creating duplicate bots', async () => {
    await mkdir(path.join(rootDir, 'data'), { recursive: true });
    await writeGlobal(['logLevel: info', 'session:', '  maxMessages: 5', '  ttlSeconds: 60', 'ai:', '  options:', '    budget:', '      rpm: 10', '      concurrency: 2', ''].join('\n'));
    await writeFile(path.join(rootDir, 'config', 'global.local.yaml'), ['session:', '  maxMessages: 9', 'ai:', '  options:', '    budget:', '      concurrency: 4', 'futureGlobal:', '  enabled: true', ''].join('\n'));
    await writeFile(path.join(rootDir, 'data', 'provider.yaml'), ['provider: openai-compatible', 'model: tracked-model', 'options:', '  headers:', '    x-one: tracked', '    x-two: tracked', ''].join('\n'));
    await writeFile(path.join(rootDir, 'data', 'provider.local.yaml'), ['model: local-provider-model', 'options:', '  headers:', '    x-two: local', ''].join('\n'));
    await writeBot('main.yaml', ['name: Main', 'ai:', '  options:', '    budget:', '      rpm: 20', 'session:', '  scope: user', ''].join('\n'));
    await writeBot('main.local.yaml', ['name: Local Main', 'ai:', '  options:', '    budget:', '      concurrency: 4', 'session:', '  threadContext: inherit-parent', 'futureBotField: true', ''].join('\n'));

    const cfg = await newLoader().load();
    expect(cfg.bots).toHaveLength(1);
    expect(cfg.bots[0]?.id).toBe('main');
    expect(cfg.bots[0]?.name).toBe('Local Main');
    expect(cfg.bots[0]?.session).toMatchObject({ maxMessages: 9, ttlSeconds: 60, scope: 'user', threadContext: 'inherit-parent' });
    expect(cfg.bots[0]?.ai.model).toBe('local-provider-model');
    expect(cfg.bots[0]?.ai.options).toMatchObject({ budget: { rpm: 20, concurrency: 4 } });
  });

  it('deep-merges tracked and local provider options', async () => {
    await writeGlobal('logLevel: info\n');
    await mkdir(path.join(rootDir, 'data'), { recursive: true });
    await writeFile(path.join(rootDir, 'data', 'provider.yaml'), ['options:', '  headers:', '    x-one: tracked', '    x-two: tracked', ''].join('\n'));
    await writeFile(path.join(rootDir, 'data', 'provider.local.yaml'), ['options:', '  headers:', '    x-two: local', ''].join('\n'));
    await writeBot('main.yaml', 'name: Main\n');
    const cfg = await newLoader().load();
    expect(cfg.global.ai.options).toEqual({ headers: { 'x-one': 'tracked', 'x-two': 'local' } });
  });

  it('keeps environment precedence above all local YAML overrides', async () => {
    await writeGlobal(['ai:', '  model: tracked', ''].join('\n'));
    await writeFile(path.join(rootDir, 'config', 'global.local.yaml'), ['logLevel: debug', 'ai:', '  model: local-global', ''].join('\n'));
    await writeBot('main.yaml', ['ai:', '  model: tracked-bot', ''].join('\n'));
    await writeBot('main.local.yaml', ['ai:', '  model: local-bot', ''].join('\n'));
    process.env['LOG_LEVEL'] = 'error';
    process.env['AI_MODEL'] = 'global-env';
    process.env['MOHO_BOT_MAIN_AI_MODEL'] = 'bot-env';
    const cfg = await newLoader().load();
    expect(cfg.global.logLevel).toBe('error');
    expect(cfg.global.ai.model).toBe('global-env');
    expect(cfg.bots[0]?.ai.model).toBe('bot-env');
  });

  it('lets global.yaml override data/provider.yaml defaults', async () => {
    await mkdir(path.join(rootDir, 'data'), { recursive: true });
    await writeFile(
      path.join(rootDir, 'data', 'provider.yaml'),
      ['provider: kilo', 'model: provider-model', 'temperature: 0.1', ''].join('\n'),
      'utf8',
    );
    await writeGlobal(['ai:', '  model: global-model', '  temperature: 0.7', ''].join('\n'));
    await writeBot('main.yaml', 'name: Main\n');

    const cfg = await newLoader().load();
    expect(cfg.global.ai.provider).toBe('kilo');
    expect(cfg.global.ai.model).toBe('global-model');
    expect(cfg.global.ai.temperature).toBe(0.7);
  });

  it('keeps media disabled by default and resolves inherited per-bot providers from env key names', async () => {
    await writeGlobal(['media:','  enabled: true','  hostAllowlist: [cdn.discordapp.com]','  vision:','    enabled: true','    model: global-vision','    apiKeyEnv: VISION_SECRET','  ocr:','    enabled: true','    apiKeyEnv: OCR_SECRET',''].join('\n'));
    await writeBot('main.yaml',['media:','  vision:','    model: bot-vision',''].join('\n'));
    process.env['VISION_SECRET']='vision-secret-value';
    const cfg=await newLoader().load(); const media=cfg.bots[0]!.media;
    expect(media.enabled).toBe(true); expect(media.hostAllowlist).toEqual(['cdn.discordapp.com']);
    expect(media.vision).toMatchObject({enabled:true,model:'bot-vision',apiKey:'vision-secret-value',apiKeyEnv:'VISION_SECRET'});
    expect(media.ocr.enabled).toBe(false); expect(media.ocr.apiKey).toBe('');
    delete process.env['VISION_SECRET'];
    const zero=await newLoader().load(); expect(zero.bots[0]!.media.vision.enabled).toBe(false);
  });

  it('keeps synthesized zero-config media disabled',async()=>{await writeGlobal('logLevel: info\n');const cfg=await newLoader().load();expect(cfg.bots[0]?.media.enabled).toBe(false);expect(cfg.bots[0]?.media.hostAllowlist).toEqual(['cdn.discordapp.com','media.discordapp.net']);expect(cfg.bots[0]?.media.vision.enabled).toBe(false);});

  it('lets a bot override inherited global ai/session values', async () => {
    await writeGlobal(
      ['ai:', '  model: global-model', '  temperature: 0.2', 'session:', '  maxMessages: 5', '  ttlSeconds: 60', ''].join('\n'),
    );
    await writeBot('main.yaml', ['ai:', '  model: bot-model', 'session:', '  maxMessages: 9', ''].join('\n'));

    const cfg = await newLoader().load();
    const bot = cfg.bots[0];

    expect(bot?.ai.model).toBe('bot-model');
    expect(bot?.ai.temperature).toBe(0.2);
    expect(bot?.session.maxMessages).toBe(9);
    expect(bot?.session.ttlSeconds).toBe(60);
    expect(cfg.global.ai.model).toBe('global-model');
  });

  it('gives env vars precedence over yaml, and per-bot env over global env', async () => {
    await writeGlobal(['logLevel: info', 'ai:', '  model: yaml-model', ''].join('\n'));
    await writeBot('main.yaml', ['ai:', '  model: bot-yaml-model', ''].join('\n'));

    process.env['LOG_LEVEL'] = 'warn';
    process.env['AI_MODEL'] = 'env-model';
    process.env['AI_API_KEY'] = 'env-api-key-1234567890';
    process.env['DISCORD_TOKEN'] = 'env-discord-token-1234567890';
    process.env['MOHO_ADAPTER'] = 'console';
    process.env['MOHO_STORAGE_PATH'] = '/tmp/moho-env.db';

    let cfg = await newLoader().load();
    let bot = cfg.bots[0];

    expect(cfg.global.logLevel).toBe('warn');
    expect(cfg.global.storage.path).toBe('/tmp/moho-env.db');
    expect(bot?.ai.model).toBe('env-model');
    expect(bot?.ai.apiKey).toBe('env-api-key-1234567890');
    expect(bot?.discord.token).toBe('env-discord-token-1234567890');
    expect(bot?.adapter).toBe('console');

    process.env['MOHO_BOT_MAIN_AI_MODEL'] = 'bot-env-model';
    process.env['MOHO_BOT_MAIN_DISCORD_TOKEN'] = 'bot-env-token-1234567890';

    cfg = await newLoader().load();
    bot = cfg.bots[0];
    expect(bot?.ai.model).toBe('bot-env-model');
    expect(bot?.discord.token).toBe('bot-env-token-1234567890');
  });

  it('reads a .env file without clobbering real environment variables', async () => {
    await writeGlobal('logLevel: info\n');
    await writeBot('main.yaml', 'name: Main\n');
    await writeFile(
      path.join(rootDir, '.env'),
      ['# secrets', 'AI_MODEL=dotenv-model', 'AI_API_KEY="dotenv-key-1234567890"', 'LOG_LEVEL=error'].join('\n'),
      'utf8',
    );

    process.env['LOG_LEVEL'] = 'trace';

    const cfg = await newLoader().load();
    expect(cfg.bots[0]?.ai.model).toBe('dotenv-model');
    expect(cfg.bots[0]?.ai.apiKey).toBe('dotenv-key-1234567890');
    // Real env wins over the .env file.
    expect(cfg.global.logLevel).toBe('trace');
  });

  it('skips invalid bot files but still loads their valid siblings', async () => {
    await writeGlobal('logLevel: info\n');
    await writeBot('main.yaml', 'name: Main\n');
    await writeBot('bad-schema.yaml', 'enabled: notabool\n');
    await writeBot('bad-syntax.yaml', 'name: [unterminated\n');
    await writeBot('ignored.txt', 'not a yaml file\n');

    const cfg = await newLoader().load();

    expect(cfg.bots.map((b) => b.id)).toEqual(['main']);
  });

  it('synthesizes a default "main" bot when no bot files exist', async () => {
    await writeGlobal('logLevel: info\n');

    const cfg = await newLoader().load();

    expect(cfg.bots).toHaveLength(1);
    expect(cfg.bots[0]?.id).toBe('main');
    expect(cfg.bots[0]?.name).toBe('MohoBot');
    expect(cfg.bots[0]?.ai.model).toBe('gpt-4o-mini');
  });

  it('falls back to defaults when global.yaml is missing entirely', async () => {
    const cfg = await newLoader().load();
    expect(cfg.global.logLevel).toBe('info');
    expect(cfg.bots[0]?.id).toBe('main');
  });

  it('reload() keeps the previous good config when global.yaml is corrupted', async () => {
    await writeGlobal(['logLevel: debug', 'ai:', '  model: good-model', ''].join('\n'));
    await writeBot('main.yaml', 'name: Main\n');

    const failures: Array<{ path: string; error: string }> = [];
    const reloads: Array<{ path: string }> = [];
    const events = new EventBus();
    events.on('config:reload:failed', (p) => void failures.push(p));
    events.on('config:reload', (p) => void reloads.push(p));

    const loader = newLoader(events);
    const good = await loader.load();
    expect(good.global.logLevel).toBe('debug');

    // A healthy reload emits config:reload.
    const again = await loader.reload();
    expect(again.global.ai.model).toBe('good-model');
    expect(reloads).toHaveLength(1);
    expect(failures).toHaveLength(0);

    await writeGlobal('logLevel: [corrupted\n');

    const afterCorruption = await loader.reload();

    expect(afterCorruption.global.logLevel).toBe('debug');
    expect(afterCorruption.global.ai.model).toBe('good-model');
    expect(afterCorruption).toBe(loader.current());
    expect(reloads).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.path).toContain('global.yaml');

    // And it recovers once the file is fixed again.
    await writeGlobal('logLevel: error\n');
    const recovered = await loader.reload();
    expect(recovered.global.logLevel).toBe('error');
    expect(reloads).toHaveLength(2);
  });

  it('accepts secrets in yaml and current() tracks the last good config', async () => {
    await writeGlobal('logLevel: info\n');
    await writeBot('main.yaml', ['discord:', '  token: yaml-token-1234567890', 'ai:', '  apiKey: yaml-key-1234567890', ''].join('\n'));

    const loader = newLoader();
    expect(loader.current()).toBeUndefined();

    const cfg = await loader.load();
    expect(cfg.bots[0]?.discord.token).toBe('yaml-token-1234567890');
    expect(cfg.bots[0]?.ai.apiKey).toBe('yaml-key-1234567890');
    expect(loader.current()).toBe(cfg);
  });
});
