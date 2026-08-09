/**
 * devtools command implementations.
 *
 * Everything here is a pure function over an injected `DevtoolsDeps`, so each
 * command is unit-testable with a fake provider - no runtime, no gateway, no
 * network. The plugin wrapper in ./index.ts only wires real dependencies in.
 *
 * Two hard rules apply to every function in this file:
 *  1. It never throws. A failure becomes readable text for the chat surface.
 *  2. It never prints a credential. Anything that could carry one goes through
 *     `redactHeaders()` / `scrub()` first.
 */

import type { AIConfig, ResolvedBotConfig } from '../../src/config/schema.js';
import type { AIProvider, AIUsage } from '../../src/ai/types.js';
import { AIError } from '../../src/ai/types.js';
import type { Registries } from '../../src/core/registries.js';
import { scrub } from '../../src/core/logger.js';

/** Hard cap on `!bench` iterations - a debug command must not become a load test. */
export const MAX_BENCH_RUNS = 5;
/** Default truncation for AI replies echoed into a chat surface. */
export const DEFAULT_REPLY_LIMIT = 1500;

export const REDACTED = '[REDACTED]';

export interface DevtoolsDeps {
  /**
   * Lazily resolved provider. Lazy on purpose: a bot with no credentials must
   * still be able to LOAD this plugin, and only pay for provider construction
   * when a debug command actually runs.
   */
  getProvider(): AIProvider | Promise<AIProvider>;
  registries: Registries;
  botConfig: ResolvedBotConfig;
  /** Injectable clock so latency assertions are deterministic in tests. */
  now?: () => number;
  /** Max characters of an AI reply echoed back. */
  replyLimit?: number;
}

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'cookie',
  'set-cookie',
]);

/**
 * Mask credential-bearing headers for debug output.
 *
 * `Authorization: Bearer sk-live-...` -> `Authorization: Bearer [REDACTED]`.
 * The auth scheme is kept because it is diagnostically useful and carries no
 * secret; everything after it is dropped, never truncated or hinted at.
 */
export function redactHeaders(headers: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (!SENSITIVE_HEADERS.has(lower)) {
      out[key] = scrub(value);
      continue;
    }
    if (lower === 'authorization' || lower === 'proxy-authorization') {
      const scheme = /^\s*(Bearer|Bot|Basic|Token)\b/i.exec(value)?.[1] ?? 'Bearer';
      out[key] = `${scheme} ${REDACTED}`;
      continue;
    }
    out[key] = REDACTED;
  }
  return out;
}

/** The header set an OpenAI-compatible request would carry, safe to display. */
export function requestPreview(ai: AIConfig): Record<string, string> {
  return redactHeaders({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${ai.apiKey}`,
    'User-Agent': 'mohobot-devtools',
  });
}

/** True when the runtime will silently downgrade to the offline mock provider. */
export function isMockMode(ai: AIConfig): boolean {
  return ai.apiKey.trim().length === 0 || ai.model === 'mock';
}

export function describeError(error: unknown): string {
  if (error instanceof AIError) {
    const status = error.status !== undefined ? ` http=${error.status}` : '';
    return scrub(`${error.kind}${status} attempts=${error.attempts}: ${error.message}`);
  }
  if (error instanceof Error) return scrub(`${error.name}: ${error.message}`);
  return scrub(String(error));
}

function formatUsage(usage: AIUsage | undefined): string {
  if (!usage) return 'usage n/a';
  const p = usage.promptTokens ?? 0;
  const c = usage.completionTokens ?? 0;
  const t = usage.totalTokens ?? p + c;
  return `tokens prompt=${p} completion=${c} total=${t}`;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}... [truncated ${text.length - limit} chars]`;
}

function clock(deps: DevtoolsDeps): () => number {
  return deps.now ?? Date.now;
}

/**
 * `!ai <prompt>` - bypass the session history and fire exactly one request.
 *
 * This is the whole point of the plugin: the reply you see came from one
 * isolated call with no context, so a bad answer cannot be blamed on history.
 */
export async function cmdAi(deps: DevtoolsDeps, args: string[]): Promise<string> {
  const prompt = args.join(' ').trim();
  if (prompt.length === 0) return 'usage: !ai <prompt>  (single request, no session history)';

  const ai = deps.botConfig.ai;
  const now = clock(deps);

  let provider: AIProvider;
  try {
    provider = await deps.getProvider();
  } catch (error) {
    return `[ai] provider unavailable: ${describeError(error)}`;
  }

  const started = now();
  try {
    const response = await provider.chat([{ role: 'user', content: prompt }], {
      temperature: ai.temperature,
      maxTokens: ai.maxTokens,
      timeoutMs: ai.timeoutMs,
    });
    const elapsed = now() - started;
    const body = truncate(scrub(response.content.trim()), deps.replyLimit ?? DEFAULT_REPLY_LIMIT);
    return [
      `[ai] provider=${provider.name} model=${response.model} ${elapsed}ms ` +
        `(provider ${response.ms}ms) finish=${response.finishReason ?? 'n/a'} ${formatUsage(response.usage)}`,
      body.length > 0 ? body : '(empty reply)',
    ].join('\n');
  } catch (error) {
    const elapsed = now() - started;
    return `[ai] failed after ${elapsed}ms - ${describeError(error)}`;
  }
}

/** `!models` - what the provider registry currently holds. */
export function cmdModels(deps: DevtoolsDeps): string {
  try {
    const ai = deps.botConfig.ai;
    const active = isMockMode(ai) ? 'mock' : (ai.provider || 'openai-compatible').toLowerCase();
    const entries = deps.registries.providers.list().sort((a, b) => a.name.localeCompare(b.name));
    if (entries.length === 0) return '[models] no AI providers registered';

    const lines = entries.map((entry) => {
      const marker = entry.name === active ? ' <- active' : '';
      const desc = entry.description ? ` - ${entry.description}` : '';
      return `  ${entry.name} (source: ${entry.source})${desc}${marker}`;
    });
    const note = isMockMode(ai)
      ? `  note: running in MOCK mode (${ai.apiKey.trim().length === 0 ? 'no API key' : 'model=mock'})`
      : '';
    return scrub([`[models] ${entries.length} registered, bot model=${ai.model}`, ...lines, note].filter(Boolean).join('\n'));
  } catch (error) {
    return `[models] failed: ${describeError(error)}`;
  }
}

/** `!diag` - one snapshot of every extension point plus this bot's wiring. */
export function cmdDiag(deps: DevtoolsDeps): string {
  try {
    const bot = deps.botConfig;
    const ai = bot.ai;
    const reg = deps.registries;

    const section = (label: string, entries: { name: string; source: string }[]): string => {
      if (entries.length === 0) return `  ${label}: (none)`;
      const rendered = entries
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => `${e.name}[${e.source}]`)
        .join(', ');
      return `  ${label}: ${rendered}`;
    };

    const headers = Object.entries(requestPreview(ai))
      .map(([k, v]) => `${k}: ${v}`)
      .join(' | ');

    return scrub(
      [
        '[diag] registries',
        section('providers', reg.providers.list()),
        section('gateways ', reg.gateways.list()),
        section('storages ', reg.storages.list()),
        section('memories ', reg.memories.list()),
        '[diag] bot',
        `  id=${bot.id} name=${bot.name} adapter=${bot.adapter} enabled=${bot.enabled}`,
        `  ai.provider=${ai.provider} ai.model=${ai.model} baseUrl=${ai.baseUrl}`,
        `  temperature=${ai.temperature} maxTokens=${ai.maxTokens} timeoutMs=${ai.timeoutMs} retries=${ai.retries}`,
        `  apiKey=${ai.apiKey.trim().length > 0 ? 'set' : 'not set'} mockMode=${isMockMode(ai) ? 'yes' : 'no'}`,
        `  memory.adapter=${bot.memory.adapter} session.scope=${bot.session.scope} disabledPlugins=[${bot.disabledPlugins.join(', ')}]`,
        '[diag] request headers (redacted)',
        `  ${headers}`,
      ].join('\n'),
    );
  } catch (error) {
    return `[diag] failed: ${describeError(error)}`;
  }
}

export interface BenchResult {
  runs: number;
  ok: number;
  failed: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
  firstError?: string;
}

/** Run `n` sequential single-shot requests and summarise the latency spread. */
export async function benchmark(deps: DevtoolsDeps, runs: number, prompt: string): Promise<BenchResult> {
  const now = clock(deps);
  const ai = deps.botConfig.ai;
  const provider = await deps.getProvider();

  const durations: number[] = [];
  let failed = 0;
  let firstError: string | undefined;

  for (let i = 0; i < runs; i += 1) {
    const started = now();
    try {
      await provider.chat([{ role: 'user', content: prompt }], {
        temperature: ai.temperature,
        maxTokens: ai.maxTokens,
        timeoutMs: ai.timeoutMs,
      });
      durations.push(now() - started);
    } catch (error) {
      failed += 1;
      if (firstError === undefined) firstError = describeError(error);
    }
  }

  const ok = durations.length;
  const total = durations.reduce((sum, d) => sum + d, 0);
  return {
    runs,
    ok,
    failed,
    minMs: ok > 0 ? Math.min(...durations) : 0,
    maxMs: ok > 0 ? Math.max(...durations) : 0,
    avgMs: ok > 0 ? total / ok : 0,
    firstError,
  };
}

/** `!bench <n> <prompt>` - latency spread and success rate over n requests. */
export async function cmdBench(deps: DevtoolsDeps, args: string[]): Promise<string> {
  const rawCount = args[0] ?? '';
  const parsed = Number.parseInt(rawCount, 10);
  const prompt = args.slice(1).join(' ').trim();

  if (!Number.isFinite(parsed) || parsed < 1 || prompt.length === 0) {
    return `usage: !bench <n> <prompt>  (n between 1 and ${MAX_BENCH_RUNS})`;
  }

  const runs = Math.min(parsed, MAX_BENCH_RUNS);
  const clamped = runs !== parsed ? ` (requested ${parsed}, capped at ${MAX_BENCH_RUNS})` : '';

  let result: BenchResult;
  try {
    result = await benchmark(deps, runs, prompt);
  } catch (error) {
    return `[bench] failed: ${describeError(error)}`;
  }

  const rate = result.runs > 0 ? Math.round((result.ok / result.runs) * 1000) / 10 : 0;
  const lines = [
    `[bench] runs=${result.runs}${clamped} ok=${result.ok} failed=${result.failed} success=${rate}%`,
    `  latency min=${result.minMs}ms max=${result.maxMs}ms avg=${result.avgMs.toFixed(1)}ms`,
  ];
  if (result.firstError) lines.push(`  first error: ${result.firstError}`);
  return scrub(lines.join('\n'));
}
