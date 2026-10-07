import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runSetup } from '../scripts/setup.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

async function tempRoot(): Promise<string> { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mohobot-setup-')); roots.push(root); return root; }

describe('setup wizard', () => {
  it('creates a local env, random admin token, directories and SQLite schema', async () => {
    const root = await tempRoot();
    const result = await runSetup({ rootDir: root, nonInteractive: true });
    expect(result.envCreated).toBe(true);
    expect(result.adminToken).toMatch(/^moho_[A-Za-z0-9_-]{40,}$/);
    expect(await fs.readFile(path.join(root, 'data', '.env.local'), 'utf8')).toContain(`MOHO_ADMIN_TOKEN=${result.adminToken}`);
    expect(await fs.stat(path.join(root, 'data', 'mohobot.db'))).toBeTruthy();
    expect(await fs.stat(path.join(root, 'data', 'characters'))).toBeTruthy();
    expect(await fs.stat(path.join(root, 'data', 'config', 'bots'))).toBeTruthy();
  });

  it('is repeatable and never overwrites an existing env file', async () => {
    const root = await tempRoot();
    const first = await runSetup({ rootDir: root, nonInteractive: true });
    const envPath = path.join(root, 'data', '.env.local');
    const before = await fs.readFile(envPath, 'utf8');
    const second = await runSetup({ rootDir: root, nonInteractive: true });
    expect(second.envCreated).toBe(false);
    expect(second.adminToken).toBe(first.adminToken);
    expect(await fs.readFile(envPath, 'utf8')).toBe(before);
  });

  it('fails safely for an existing env without a token unless forced', async () => {
    const root = await tempRoot();
    await fs.mkdir(path.join(root, 'data'), { recursive: true });
    await fs.writeFile(path.join(root, 'data', '.env.local'), 'DISCORD_TOKEN=placeholder\n', { mode: 0o600 });
    await expect(runSetup({ rootDir: root, nonInteractive: true })).rejects.toThrow('no MOHO_ADMIN_TOKEN');
    const result = await runSetup({ rootDir: root, nonInteractive: true, force: true });
    expect(result.envCreated).toBe(false);
    expect(await fs.readFile(path.join(root, 'data', '.env.local'), 'utf8')).toMatch(/MOHO_ADMIN_TOKEN=moho_/);
  });

  it('moves pre-relocation root and config/ files into data/ exactly once', async () => {
    const root = await tempRoot();
    await fs.mkdir(path.join(root, 'config', 'bots'), { recursive: true });
    await fs.writeFile(path.join(root, '.env.local'), 'MOHO_ADMIN_TOKEN=moho_legacy_token\n', { mode: 0o600 });
    await fs.writeFile(path.join(root, 'config', 'global.yaml'), 'logLevel: error\n');
    await fs.writeFile(path.join(root, 'config', 'bots', 'main.local.yaml'), 'name: Legacy Local\n');

    const result = await runSetup({ rootDir: root, nonInteractive: true });
    expect(result.envCreated).toBe(false);
    expect(result.adminToken).toBe('moho_legacy_token');
    expect(await fs.readFile(path.join(root, 'data', '.env.local'), 'utf8')).toContain('MOHO_ADMIN_TOKEN=moho_legacy_token');
    expect(await fs.readFile(path.join(root, 'data', 'config', 'global.yaml'), 'utf8')).toContain('logLevel: error');
    expect(await fs.readFile(path.join(root, 'data', 'config', 'bots', 'main.local.yaml'), 'utf8')).toContain('Legacy Local');
    // The legacy tree is gone, so nothing can read it by accident.
    await expect(fs.stat(path.join(root, 'config'))).rejects.toThrow();
    await expect(fs.stat(path.join(root, '.env.local'))).rejects.toThrow();

    // Repeatable: a second run must not regenerate tokens or resurrect files.
    const second = await runSetup({ rootDir: root, nonInteractive: true });
    expect(second.adminToken).toBe('moho_legacy_token');
    expect(second.envCreated).toBe(false);
  });

  it('keeps data/ files when a legacy copy also exists', async () => {
    const root = await tempRoot();
    await fs.mkdir(path.join(root, 'config'), { recursive: true });
    await fs.mkdir(path.join(root, 'data', 'config'), { recursive: true });
    await fs.writeFile(path.join(root, 'config', 'global.yaml'), 'logLevel: error\n');
    await fs.writeFile(path.join(root, 'data', 'config', 'global.yaml'), 'logLevel: warn\n');
    await runSetup({ rootDir: root, nonInteractive: true });
    expect(await fs.readFile(path.join(root, 'data', 'config', 'global.yaml'), 'utf8')).toContain('logLevel: warn');
  });
});
