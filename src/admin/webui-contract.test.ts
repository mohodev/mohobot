import{readFile,readdir}from'node:fs/promises';import{describe,expect,it}from'vitest';

/**
 * The React control center replaced the legacy vanilla console. These tests
 * preserve the guarantees the old `webui-contract` / `webui-chinese` suites
 * enforced, but now guard the React source that actually ships.
 */

const SRC = new URL('../../dashboard/src/', import.meta.url);

/** Forbidden usages below are code-level; strip comments so prose never trips them. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

async function readSourceTree(dir: URL): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  const parts: string[] = [];
  for (const entry of entries) {
    const target = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
    if (entry.isDirectory()) parts.push(await readSourceTree(target));
    else if (/\.(ts|tsx)$/.test(entry.name)) parts.push(stripComments(await readFile(target, 'utf8')));
  }
  return parts.join('\n');
}

describe('React control center API contract', () => {
  it('issues the server confirmation method/path/body contract and never bypasses route policy', async () => {
    const api = await readFile(new URL('lib/api.ts', SRC), 'utf8');
    // Confirmation is requested with the exact replay payload the server verifies.
    expect(api).toContain("body({ method: options.method ?? 'POST', path, body: payload })");
    expect(api).toContain("headers.set('X-Admin-Confirmation', nonce)");
    expect(api).toContain("phrase !== '确认'");
    expect(api).not.toContain("'CONFIRM'");
  });

  it('keeps the session token in memory and sessionStorage, never localStorage', async () => {
    const tree = await readSourceTree(SRC);
    expect(tree).not.toContain('localStorage');
    expect(tree).not.toContain('x-admin-actor');
    expect(tree).not.toContain('/remote/health');
    expect(tree).not.toContain('outbox');
  });

  it('collects the documented payload shapes for write operations', async () => {
    const tree = await readSourceTree(SRC);
    // knowledge base creation sends a name (and optional id) only
    expect(tree).toContain('{ name }');
    // debug capabilities are read from the `capabilities.bots` envelope
    expect(tree).toContain('capabilities.bots');
    // log streaming gap flag
    expect(tree).toContain('gap');
    // device network matrix uses `wifi`, never the retired `online`
    expect(tree).toContain("'wifi'");
    expect(tree).not.toContain('value="online"');
    // affinity adjustment payload names
    expect(tree).toContain('botId');
    expect(tree).toContain('userId');
    expect(tree).toContain('delta');
    expect(tree).toContain('note');
    // principal is read from the auth envelope
    expect(tree).toContain('auth?.principal');
  });
});
