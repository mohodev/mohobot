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
import type { EmbedCard, EmbedField, MohoMessage } from '../../src/core/types.js';
import type { Session, SessionManagerLike } from '../../src/session/types.js';
import { readdirSync } from 'node:fs';
import path from 'node:path';

/** Hard cap on `!bench` iterations - a debug command must not become a load test. */
export const MAX_BENCH_RUNS = 5;
/** Default truncation for AI replies echoed into a chat surface. */
export const DEFAULT_REPLY_LIMIT = 1500;

export const REDACTED = '[REDACTED]';

/** MohoBot brand color for rich embed cards (hex 0x6a5acd). */
const CARD_COLOR = 0x6a5acd;
const CARD_FOOTER = 'devtools';

/** Wrap a block of text into a themed EmbedCard. */
function card(description: string, extra: Partial<EmbedCard> = {}): EmbedCard {
  return { description, color: CARD_COLOR, footer: CARD_FOOTER, ...extra };
}

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
  /** Live session store, exposed read-only for inspect commands (e.g. !记忆). */
  sessions?: SessionManagerLike;
  /** Live pipeline handle, used to re-feed a synthetic command (e.g. !清空 -> !clear). */
  pipeline?: { handle(message: MohoMessage): Promise<void> };
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
export async function cmdAi(deps: DevtoolsDeps, args: string[]): Promise<EmbedCard> {
  const prompt = args.join(' ').trim();
  if (prompt.length === 0) return card('usage: !ai <prompt>  (single request, no session history)');

  const ai = deps.botConfig.ai;
  const now = clock(deps);

  let provider: AIProvider;
  try {
    provider = await deps.getProvider();
  } catch (error) {
    return card(`[ai] provider unavailable: ${describeError(error)}`);
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
    return card([
      `[ai] provider=${provider.name} model=${response.model} ${elapsed}ms ` +
        `(provider ${response.ms}ms) finish=${response.finishReason ?? 'n/a'} ${formatUsage(response.usage)}`,
      body.length > 0 ? body : '(empty reply)',
    ].join('\n'));
  } catch (error) {
    const elapsed = now() - started;
    return card(`[ai] failed after ${elapsed}ms - ${describeError(error)}`);
  }
}

/** `!models` - what the provider registry currently holds. */
export function cmdModels(deps: DevtoolsDeps): EmbedCard {
  try {
    const ai = deps.botConfig.ai;
    const active = isMockMode(ai) ? 'mock' : (ai.provider || 'openai-compatible').toLowerCase();
    const entries = deps.registries.providers.list().sort((a, b) => a.name.localeCompare(b.name));
    if (entries.length === 0) return card('[models] no AI providers registered');

    const lines = entries.map((entry) => {
      const marker = entry.name === active ? ' <- active' : '';
      const desc = entry.description ? ` - ${entry.description}` : '';
      return `  ${entry.name} (source: ${entry.source})${desc}${marker}`;
    });
    const note = isMockMode(ai)
      ? `  note: running in MOCK mode (${ai.apiKey.trim().length === 0 ? 'no API key' : 'model=mock'})`
      : '';
    return card(scrub([`[models] ${entries.length} registered, bot model=${ai.model}`, ...lines, note].filter(Boolean).join('\n')));
  } catch (error) {
    return card(`[models] failed: ${describeError(error)}`);
  }
}

/** `!diag` - one snapshot of every extension point plus this bot's wiring. */
export function cmdDiag(deps: DevtoolsDeps): EmbedCard {
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

    return card(scrub(
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
    ));
  } catch (error) {
    return card(`[diag] failed: ${describeError(error)}`);
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
export async function cmdBench(deps: DevtoolsDeps, args: string[]): Promise<EmbedCard> {
  const rawCount = args[0] ?? '';
  const parsed = Number.parseInt(rawCount, 10);
  const prompt = args.slice(1).join(' ').trim();

  if (!Number.isFinite(parsed) || parsed < 1 || prompt.length === 0) {
    return card(`usage: !bench <n> <prompt>  (n between 1 and ${MAX_BENCH_RUNS})`);
  }

  const runs = Math.min(parsed, MAX_BENCH_RUNS);
  const clamped = runs !== parsed ? ` (requested ${parsed}, capped at ${MAX_BENCH_RUNS})` : '';

  let result: BenchResult;
  try {
    result = await benchmark(deps, runs, prompt);
  } catch (error) {
    return card(`[bench] failed: ${describeError(error)}`);
  }

  const rate = result.runs > 0 ? Math.round((result.ok / result.runs) * 1000) / 10 : 0;
  const lines = [
    `[bench] runs=${result.runs}${clamped} ok=${result.ok} failed=${result.failed} success=${rate}%`,
    `  latency min=${result.minMs}ms max=${result.maxMs}ms avg=${result.avgMs.toFixed(1)}ms`,
  ];
  if (result.firstError) lines.push(`  first error: ${result.firstError}`);
  return card(scrub(lines.join('\n')));
}


/**
 * `!清空` - clear the current user's session context.
 *
 * Reuses the pipeline's built-in `!clear` command rather than touching the
 * session store directly: we re-feed a synthetic `!clear` message through the
 * REAL pipeline, so the exact same clear path (and its "Context cleared."
 * reply) runs. One source of truth for clearing.
 */
export async function cmdClear(deps: DevtoolsDeps, message: MohoMessage): Promise<string | void> {
  if (!deps.pipeline) return '[清空] pipeline unavailable (bot not fully started)';
  const pipe = deps.pipeline;
  const src = message;
  const synthetic: MohoMessage = {
    id: src.id,
    platform: src.platform,
    botId: src.botId,
    channel: src.channel,
    author: src.author,
    content: '!clear',
    mentionsBot: false,
    attachments: [],
    createdAt: Date.now(),
  };
  await pipe.handle(synthetic);
  // The re-fed !clear replies "Context cleared." itself; stay silent here.
  return undefined;
}

/**
 * `!记忆` - show the current session's recent history: message count plus a
 * short summary of the latest turns. Pure read against the session store.
 */
export async function cmdMemory(deps: DevtoolsDeps, message: MohoMessage): Promise<EmbedCard> {
  if (!deps.sessions) return card('[记忆] session store unavailable (bot not fully started)');
  const key = {
    botId: deps.botConfig.id,
    channelId: message.channel.id,
    userId: message.author.id,
  };
  let session: Session;
  try {
    session = await deps.sessions.get(key);
  } catch (error) {
    return card(`[记忆] failed to read session: ${describeError(error)}`);
  }
  const messages = session.messages ?? [];
  const count = messages.length;
  const limit = deps.botConfig.session.maxMessages;
  if (count === 0) {
    return card(`[记忆] 当前会话为空（还没有对话记录）。上下文上限 ${limit} 条。`, { title: '记忆' });
  }
  const recent = messages.slice(-5);
  const fields: EmbedField[] = recent.map((m, i) => ({
    name: `[${m.role}] #${count - recent.length + i + 1}`,
    value: m.content.replace(/\s+/g, ' ').trim().slice(0, 120) || '(empty)',
    inline: false,
  }));
  return card(`当前会话共 ${count} 条（上下文上限 ${limit} 条）。最近 ${recent.length} 条：`, {
    title: '记忆',
    fields,
  });
}

/**
 * `!换人` - list the available personas (data/prompts/*.md) and the active one.
 *
 * A full runtime persona switch needs per-user persona infrastructure + hot
 * reload, which is out of scope for this MVP; here we surface the choices and
 * explain what switching would require. `!换人 <file>` notes the requested one.
 */
export function cmdSwitchPersona(deps: DevtoolsDeps, args: string[]): EmbedCard {
  const current = deps.botConfig.systemPromptFile ?? '(inline systemPrompt - 未使用文件)';
  let files: string[] = [];
  try {
    const dir = path.join(process.cwd(), 'data', 'prompts');
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort();
  } catch {
    files = [];
  }
  if (files.length === 0) {
    return card(`[换人] 可用人格目录 data/prompts/ 为空或不可读。当前人格：${current}`, { title: '换人' });
  }
  const activeIdx = files.findIndex((f) => f === current || `data/prompts/${f}` === current);
  const list = files
    .map((f, i) => `  ${i + 1}. ${f}${i === activeIdx ? '  <- 当前' : ''}`)
    .join('\n');
  if (args.length > 0) {
    const want = args.join(' ').trim();
    const match = files.find((f) => f === want || f === `${want}.md`);
    const note = match
      ? `  请求切换到 "${match}"。注意：完整运行时切换需多人基础设施（每用户人格 + 热重载），当前版本仅列出可用项，不会真正改写人格。`
      : `  未找到人格 "${want}"。可用：${files.join(', ')}`;
    return card(scrub(`[换人] 当前人格：${current}\n可用人格：\n${list}\n${note}`), { title: '换人' });
  }
  return card(scrub(`[换人] 当前人格：${current}\n可用人格：\n${list}\n切换：!换人 <文件名>（完整切换需多人基础设施，当前仅列出）`), { title: '换人' });
}
