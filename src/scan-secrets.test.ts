import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatFindings, isCodeReference, redact, scanHistory, scanText, scanWorkingTree } from '../scripts/scan-secrets.js';

// Fake credentials are assembled at runtime so this file never matches its own rules.
const fake = {
  discord: ['M' + 'A'.repeat(23), 'B'.repeat(6), 'C'.repeat(27)].join('.'),
  jwt: ['eyJ' + 'a'.repeat(12), 'eyJ' + 'b'.repeat(12), 'c'.repeat(12)].join('.'),
  cloudflare: 'cfut_' + 'Q'.repeat(30),
  openai: 'sk-' + 'Z'.repeat(30),
  nvidia: 'nvapi-' + 'Y'.repeat(30),
  github: 'ghp_' + 'X'.repeat(36),
  aws: 'AKIA' + 'W'.repeat(16),
  pem: '-----BEGIN ' + 'RSA PRIVATE KEY-----',
  bearer: 'Bearer ' + 'v'.repeat(40),
};

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true }))); });

function rulesHit(text: string): string[] {
  return scanText(text, 'f.txt').map((f) => f.rule);
}

describe('scanText rules', () => {
  it.each([
    ['discord-bot-token', `token: ${fake.discord}`],
    ['jwt', `"key": ["${fake.jwt}"]`],
    ['cloudflare-api-token', `KEY ${fake.cloudflare}`],
    ['openai-style-key', `OPENAI=${fake.openai}`],
    ['nvidia-api-key', `k=${fake.nvidia}`],
    ['github-token', `GH=${fake.github}`],
    ['aws-access-key-id', `id=${fake.aws}`],
    ['private-key-block', fake.pem],
    ['bearer-token', `Authorization: ${fake.bearer}`],
    ['credential-assignment', `apiKey: "${'k'.repeat(10)}${'9'.repeat(20)}"`],
  ])('detects %s', (rule, text) => {
    expect(rulesHit(text)).toEqual([rule]);
  });

  it('ignores placeholders, env references, short values and obvious dummies', () => {
    for (const text of [
      'apiKey: ${KILO_API_KEY}',
      'password = <your password>',
      'AI_API_KEY=sk-fake-key-for-documentation-only-1234',
      'api_key: "test-key-123456"',
      'token: short',
      'const apiKey = process.env.KILO_API_KEY',
      'api_key: example-api-key-placeholder-value-1234',
    ]) expect(rulesHit(text), text).toEqual([]);
  });

  it('treats references to secrets as code, but still flags opaque values', () => {
    for (const v of ['process.env.KILO_API_KEY', 'import.meta.env.VITE_SECRET_KEY_NAME', 'os.environ', 'config.provider.apiKey', 'KILO_API_KEY_NAME_X']) {
      expect(isCodeReference(v), v).toBe(true);
    }
    // Assembled at runtime so this tracked file never contains a literal the scanner would flag.
    const opaque = 'k9Zq3Lm2Xa8Vb7Nc6' + 'Rd5Te4Wf1Ug0';
    for (const v of [opaque, 'abcDEF123456' + 'abcDEF123456xyz']) expect(isCodeReference(v), v).toBe(false);
    expect(rulesHit('apiKey = process.env.SOME_VERY_LONG_ENV_NAME_HERE')).toEqual([]);
    expect(rulesHit(`password: "${opaque}"`)).toEqual(['credential-assignment']);
  });

  it('honours the inline suppression marker', () => {
    expect(rulesHit(`k=${fake.openai} # secretscan:ignore`)).toEqual([]);
  });

  it('reports the right line numbers and one finding per line', () => {
    const found = scanText(['ok', `a ${fake.openai} ${fake.github}`, 'ok', fake.pem].join('\n'), 'x.md');
    expect(found.map((f) => [f.file, f.line])).toEqual([['x.md', 2], ['x.md', 4]]);
  });

  it('never leaks the secret in its output', () => {
    const finding = scanText(`k=${fake.openai}`, 'f')[0]!;
    expect(finding.preview).not.toContain(fake.openai);
    expect(finding.preview.length).toBeLessThan(40);
    expect(redact(fake.github)).not.toContain(fake.github.slice(8));
    const text = formatFindings([finding]);
    expect(text).not.toContain(fake.openai);
    expect(text).toContain('f:1');
    expect(formatFindings([])).toBe('No secrets found.');
  });

  it('skips pathological minified lines instead of burning CPU', () => {
    expect(scanText(`${'x'.repeat(5000)} ${fake.openai}`, 'min.js')).toEqual([]);
  });
});

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

async function tempRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mohobot-scan-'));
  roots.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 't@example.invalid');
  git(root, 'config', 'user.name', 'T');
  return root;
}

describe('repository scans', () => {
  it('finds tracked secrets, skips untracked/ignored/binary/vendored files', async () => {
    const root = await tempRepo();
    await fs.writeFile(path.join(root, 'leak.yaml'), `key: ${fake.cloudflare}\n`);
    await fs.writeFile(path.join(root, 'clean.md'), 'nothing here\n');
    await fs.writeFile(path.join(root, 'blob.bin'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(fake.openai)]));
    await fs.mkdir(path.join(root, 'node_modules'));
    await fs.writeFile(path.join(root, 'node_modules', 'dep.js'), `k='${fake.openai}'\n`);
    await fs.writeFile(path.join(root, 'untracked.txt'), `${fake.openai}\n`);
    git(root, 'add', 'leak.yaml', 'clean.md', 'blob.bin');
    git(root, 'add', '-f', 'node_modules/dep.js');

    const found = await scanWorkingTree(root);
    expect(found.map((f) => `${f.file}:${f.line}:${f.rule}`)).toEqual(['leak.yaml:1:cloudflare-api-token']);
  });

  it('finds a secret that was committed and later deleted, naming the commit', async () => {
    const root = await tempRepo();
    await fs.writeFile(path.join(root, 'cfg.yaml'), `# header\ntoken: ${fake.github}\n`);
    git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'oops');
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    await fs.writeFile(path.join(root, 'cfg.yaml'), '# header\ntoken: ${GH_TOKEN}\n');
    git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'fix');

    expect(await scanWorkingTree(root)).toEqual([]);
    const history = await scanHistory(root);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ file: 'cfg.yaml', line: 2, rule: 'github-token', commit: head.slice(0, 12) });
    expect(JSON.stringify(history)).not.toContain(fake.github);
  });

  it('rejects a directory that is not a git repository', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mohobot-nogit-'));
    roots.push(dir);
    await expect(scanWorkingTree(dir)).rejects.toThrow(/git/);
  });
});

describe('this repository', () => {
  it('has no credential-shaped values in tracked files (run `npm run scan-secrets -- --history` for history)', async () => {
    const repo = path.resolve(import.meta.dirname, '..');
    const inGit = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: repo, encoding: 'utf8' });
    if (inGit.status !== 0) return; // e.g. a source tarball without .git
    const found = await scanWorkingTree(repo);
    expect(formatFindings(found)).toBe('No secrets found.');
  });
});
