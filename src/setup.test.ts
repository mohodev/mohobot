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
    expect(await fs.readFile(path.join(root, '.env.local'), 'utf8')).toContain(`MOHO_ADMIN_TOKEN=${result.adminToken}`);
    expect(await fs.stat(path.join(root, 'data', 'mohobot.db'))).toBeTruthy();
    expect(await fs.stat(path.join(root, 'data', 'characters'))).toBeTruthy();
  });

  it('is repeatable and never overwrites an existing env file', async () => {
    const root = await tempRoot();
    const first = await runSetup({ rootDir: root, nonInteractive: true });
    const envPath = path.join(root, '.env.local');
    const before = await fs.readFile(envPath, 'utf8');
    const second = await runSetup({ rootDir: root, nonInteractive: true });
    expect(second.envCreated).toBe(false);
    expect(second.adminToken).toBe(first.adminToken);
    expect(await fs.readFile(envPath, 'utf8')).toBe(before);
  });

  it('fails safely for an existing env without a token unless forced', async () => {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, '.env.local'), 'DISCORD_TOKEN=placeholder\n', { mode: 0o600 });
    await expect(runSetup({ rootDir: root, nonInteractive: true })).rejects.toThrow('no MOHO_ADMIN_TOKEN');
    const result = await runSetup({ rootDir: root, nonInteractive: true, force: true });
    expect(result.envCreated).toBe(false);
    expect(await fs.readFile(path.join(root, '.env.local'), 'utf8')).toMatch(/MOHO_ADMIN_TOKEN=moho_/);
  });
});
