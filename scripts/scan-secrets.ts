/**
 * Local secret scanner: `npm run scan-secrets [-- --history]`.
 *
 * Scans tracked files (and optionally every commit's added lines) for things
 * that look like live credentials. Findings are ALWAYS redacted - the tool must
 * never become a second place a secret leaks. Exit code 1 when anything is
 * found, so it can sit in a pre-commit hook or CI step.
 *
 * Suppress a deliberate false positive by putting `secretscan:ignore` on the
 * same line (e.g. a documented dummy value).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export interface Finding {
  rule: string;
  file: string;
  line: number;
  /** Redacted preview: never contains the secret itself. */
  preview: string;
  commit?: string;
}

interface Rule {
  id: string;
  pattern: RegExp;
  /** When set, capture group 1 is the candidate value and this can veto it. */
  reject?: (value: string) => boolean;
}

const IGNORE_MARKER = 'secretscan:ignore';
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SKIP_PATH = /(^|\/)(node_modules|dist|\.git)\//;
const SKIP_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|db|sqlite|woff2?|ttf|lock)$/i;
const SKIP_FILE = /(^|\/)package-lock\.json$/;

/** `process.env.X`, `os.environ`, `config.apiKey`, `KILO_API_KEY`: a reference to a secret, not a secret. */
export function isCodeReference(value: string): boolean {
  if (/^(?:process\.env|import\.meta\.env|os\.environ|os\.getenv|env)\b/.test(value)) return true;
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value)) return true; // dotted identifier path
  return /^[A-Z][A-Z0-9_]{5,}$/.test(value); // ALL_CAPS constant / env var name
}

const RULES: Rule[] = [
  { id: 'discord-bot-token', pattern: /\b[MNO][A-Za-z\d_-]{23,25}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}\b/ },
  { id: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { id: 'cloudflare-api-token', pattern: /\bcfut_[A-Za-z0-9]{24,}\b/ },
  { id: 'openai-style-key', pattern: /\bsk-(?:proj-|live-)?(?!fake|test|dummy|example|your|xxx|placeholder)[A-Za-z0-9_-]{24,}\b/i },
  { id: 'nvidia-api-key', pattern: /\bnvapi-[A-Za-z0-9_-]{24,}\b/ },
  { id: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { id: 'aws-access-key-id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'private-key-block', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/ },
  { id: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{32,}/ },
  {
    id: 'credential-assignment',
    // key/token/secret/password = "long opaque value", skipping ${ENV} placeholders and obvious dummies.
    pattern: /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|password|passwd)\b["']?\s*[:=]\s*["']?(?!\$\{)(?!<)(?![A-Za-z]*(?:example|changeme|your|xxx|dummy|test|placeholder|redacted))([A-Za-z0-9_\-./+=]{24,})/i,
    reject: isCodeReference,
  },
];

/** Keep just enough to locate the finding: first 4 chars + length, never the value. */
export function redact(match: string): string {
  const visible = match.slice(0, 4).replace(/[^\w-]/g, '?');
  return `${visible}…[${match.length} chars redacted]`;
}

export function scanText(text: string, file: string, commit?: string): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.length > 4000 || line.includes(IGNORE_MARKER)) continue;
    for (const rule of RULES) {
      const match = rule.pattern.exec(line);
      if (match && rule.reject?.(match[1] ?? match[0])) continue;
      if (match) {
        findings.push({ rule: rule.id, file, line: i + 1, preview: redact(match[0]), ...(commit ? { commit } : {}) });
        break; // one finding per line is enough to locate it
      }
    }
  }
  return findings;
}

function run(command: string, args: readonly string[], cwd: string): Promise<{ code: number; stdout: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(chunks) }));
  });
}

export async function scanWorkingTree(rootDir: string): Promise<Finding[]> {
  const listed = await run('git', ['ls-files', '-z'], rootDir);
  if (listed.code !== 0) throw new Error('not a git repository (git ls-files failed)');
  const files = listed.stdout.toString('utf8').split('\0').filter(Boolean);
  const findings: Finding[] = [];
  for (const rel of files) {
    if (SKIP_PATH.test(rel) || SKIP_EXT.test(rel) || SKIP_FILE.test(rel)) continue;
    const full = path.join(rootDir, rel);
    let stat;
    try { stat = await fs.stat(full); } catch { continue; } // deleted but still indexed
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
    const buffer = await fs.readFile(full);
    if (buffer.includes(0)) continue; // binary
    findings.push(...scanText(buffer.toString('utf8'), rel));
  }
  return findings;
}

/** Scan only the lines each commit ADDED, across every ref. */
export async function scanHistory(rootDir: string): Promise<Finding[]> {
  const log = await run('git', ['log', '--all', '--no-color', '-p', '--unified=0', '--format=@@commit %H'], rootDir);
  if (log.code !== 0) throw new Error('git log failed');
  const findings: Finding[] = [];
  let commit = '';
  let file = '';
  let lineNo = 0;
  for (const raw of log.stdout.toString('utf8').split('\n')) {
    if (raw.startsWith('@@commit ')) { commit = raw.slice(9).trim(); continue; }
    if (raw.startsWith('+++ ')) { file = raw.slice(4).replace(/^b\//, ''); continue; }
    if (raw.startsWith('@@')) { const m = /\+(\d+)/.exec(raw); lineNo = m ? Number(m[1]) - 1 : 0; continue; }
    if (!raw.startsWith('+') || raw.startsWith('+++')) continue;
    lineNo += 1;
    if (SKIP_PATH.test(file) || SKIP_EXT.test(file) || SKIP_FILE.test(file)) continue;
    const added = raw.slice(1);
    for (const f of scanText(added, file, commit.slice(0, 12))) findings.push({ ...f, line: lineNo });
  }
  return findings;
}

export function formatFindings(findings: Finding[]): string {
  if (findings.length === 0) return 'No secrets found.';
  const lines = findings.map((f) => `${f.commit ? `${f.commit} ` : ''}${f.file}:${f.line}  [${f.rule}]  ${f.preview}`);
  return [`${findings.length} potential secret(s) found (values redacted):`, ...lines].join('\n');
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const history = process.argv.includes('--history');
  const root = process.cwd();
  (async () => {
    const findings = [...await scanWorkingTree(root), ...(history ? await scanHistory(root) : [])];
    console.log(formatFindings(findings));
    process.exitCode = findings.length > 0 ? 1 : 0;
  })().catch((error: unknown) => {
    console.error(`scan-secrets failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  });
}
