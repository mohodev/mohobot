/**
 * Logging with mandatory secret redaction.
 *
 * Security requirement: tokens and API keys must NEVER reach a log sink.
 * Redaction happens twice - structurally (pino redact paths) and textually
 * (registered secret values are masked anywhere they appear in a string).
 */

import pino, { type Logger as PinoLogger } from 'pino';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface Logger {
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  fatal(obj: unknown, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

const REDACT_PATHS = [
  'token',
  'discordToken',
  'apiKey',
  'api_key',
  'authorization',
  'password',
  'secret',
  '*.token',
  '*.apiKey',
  '*.api_key',
  '*.authorization',
  'config.discord.token',
  'config.ai.apiKey',
  'headers.authorization',
];

const MASK = '[REDACTED]';

/** Values registered here are masked out of every log string. */
const secrets = new Set<string>();

/** Register a secret so it can never leak through a message body. */
export function registerSecret(value: string | undefined | null): void {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (trimmed.length < 8) return; // too short to mask safely
  secrets.add(trimmed);
}

export function clearSecrets(): void {
  secrets.clear();
}

/** Mask every registered secret occurring in the given text. */
export function scrub(text: string): string {
  let out = text;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join(MASK);
  }
  // Defensive patterns for secrets never registered (e.g. echoed by an API).
  out = out.replace(/(Bot\s+)[A-Za-z0-9._-]{20,}/g, `$1${MASK}`);
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._-]{20,}/g, `$1${MASK}`);
  out = out.replace(/\bsk-[A-Za-z0-9]{16,}\b/g, MASK);
  return out;
}

function scrubDeep(value: unknown, depth = 0): unknown {
  if (depth > 6) return value;
  if (typeof value === 'string') return scrub(value);
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: scrub(value.message), stack: value.stack ? scrub(value.stack) : undefined };
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubDeep(v, depth + 1);
    }
    return out;
  }
  return value;
}

function wrap(base: PinoLogger): Logger {
  const call = (level: LogLevel) => (obj: unknown, msg?: string) => {
    const safeMsg = typeof msg === 'string' ? scrub(msg) : undefined;
    if (typeof obj === 'string') {
      base[level](scrub(obj));
      return;
    }
    base[level](scrubDeep(obj) as object, safeMsg);
  };
  return {
    trace: call('trace'),
    debug: call('debug'),
    info: call('info'),
    warn: call('warn'),
    error: call('error'),
    fatal: call('fatal'),
    child: (bindings) => wrap(base.child(scrubDeep(bindings) as Record<string, unknown>)),
  };
}

export interface LoggerOptions {
  level?: LogLevel;
  pretty?: boolean;
  name?: string;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? (process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info';
  const pretty = options.pretty ?? process.env.NODE_ENV !== 'production';
  const base = pino({
    name: options.name ?? 'mohobot',
    level,
    redact: { paths: REDACT_PATHS, censor: MASK },
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : {}),
  });
  return wrap(base);
}

/** Silent logger for tests. */
export function createNullLogger(): Logger {
  const noop = () => {};
  const self: Logger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => self,
  };
  return self;
}
