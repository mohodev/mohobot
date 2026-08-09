/**
 * Pure catalog helpers for the Kilo AI gateway model list.
 *
 * Everything in this file is a pure function: no I/O, no logging, no globals,
 * no reliance on the network. That is what makes the lint rules testable
 * against a frozen fixture instead of a live endpoint.
 *
 * Tolerance is a hard requirement: the upstream /models payload is third-party
 * data and has been observed to carry broken markdown, missing vendor
 * prefixes, alias ids and truncated descriptions. Nothing here may throw on
 * malformed input - bad entries are skipped, missing fields get defaults.
 */

export interface ModelPricing {
  prompt?: string;
  completion?: string;
  request?: string;
  image?: string;
  inputCacheRead?: string;
  inputCacheWrite?: string;
}

export interface CatalogModel {
  /** Raw id exactly as served, including any leading '~'. */
  id: string;
  name: string;
  /** Description exactly as served. */
  description: string;
  /** Description with markdown / truncation artefacts repaired. */
  cleanDescription: string;
  contextLength?: number;
  maxCompletionTokens?: number;
  pricing: ModelPricing;
  supportedParameters: string[];
  inputModalities: string[];
  outputModalities: string[];
  /** Canonical free test: the id carries the ':free' suffix. */
  free: boolean;
  /** Vendor segment of the id ('~' stripped), undefined when the id has none. */
  vendor?: string;
  /** The id starts with '~' (gateway alias / "latest" pointer). */
  tildePrefixed: boolean;
  /** Both prompt and completion price parse to 0. */
  zeroPriced: boolean;
  /** Upstream 'isFree' hint, when present. */
  isFreeFlag?: boolean;
}

export type LintIssueKind =
  | 'single-asterisk-markdown'
  | 'missing-vendor-prefix'
  | 'tilde-prefixed-id'
  | 'truncated-description'
  | 'empty-description'
  | 'missing-context-length';

export interface LintIssue {
  modelId: string;
  issue: LintIssueKind;
  detail: string;
}

/** Human readable one-liners, used by the !lint report header. */
export const LINT_ISSUE_LABELS: Record<LintIssueKind, string> = {
  'single-asterisk-markdown': 'description uses single-asterisk emphasis (renders italic in Discord)',
  'missing-vendor-prefix': "name is missing the 'Vendor: ' prefix used by the rest of the catalog",
  'tilde-prefixed-id': "id starts with '~' (gateway alias, not a concrete model)",
  'truncated-description': 'description is cut off upstream',
  'empty-description': 'description is empty',
  'missing-context-length': 'context_length is missing or not a positive number',
};

const ELLIPSIS = '\u2026';
const BOLD_OPEN = '\u0000B';
const BOLD_CLOSE = 'B\u0000';
const BOLD_TOKEN_RE = /\u0000B(\d+)B\u0000/g;

/** 'inclusionAI: Ling 2.6 1T' -> has prefix. 'Ling-3.0-flash' -> has not. */
const VENDOR_PREFIX_RE = /^[^:]+:\s/;

/* ------------------------------------------------------------------ */
/* small tolerant coercions                                            */
/* ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function asPositiveNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const s = asString(entry);
    if (s !== undefined && s !== '') out.push(s);
  }
  return out;
}

function asPriceString(value: unknown): string | undefined {
  const s = asString(value);
  if (s === undefined) return undefined;
  const trimmed = s.trim();
  return trimmed === '' ? undefined : trimmed;
}

function priceToNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/* ------------------------------------------------------------------ */
/* description repair                                                  */
/* ------------------------------------------------------------------ */

/**
 * True when the text uses single-asterisk emphasis outside of any proper
 * '**bold**' run. Upstream 'inclusionai/ling-3.0-flash' is the live example:
 * its whole description is wrapped in single '*', which Markdown renders as
 * italics even though the intent was clearly bold.
 */
export function hasSingleAsteriskEmphasis(text: unknown): boolean {
  if (typeof text !== 'string' || text === '') return false;
  const withoutBold = text.replace(/\*\*[\s\S]*?\*\*/g, '');
  return /\*[^*\n]+\*/.test(withoutBold);
}

/** True when the text was cut off upstream ('...' or a real ellipsis at the end). */
export function isTruncatedText(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  return /(\.{3,}|\u2026)\s*$/.test(text.trim());
}

/**
 * Repair a model description for chat rendering.
 *
 *  1. paired single '*...*' becomes '**...**' (the upstream intent)
 *  2. leftover unpaired '*' are dropped so Discord cannot swallow punctuation
 *  3. a trailing '...' is normalised to a single ellipsis character so a
 *     truncated blurb reads as truncated instead of as a broken sentence
 *  4. whitespace is collapsed to at most one blank line
 *
 * Never throws; non-strings become ''.
 */
export function sanitizeDescription(text: unknown): string {
  if (typeof text !== 'string') return '';
  let work = text.replace(/\r\n/g, '\n').trim();
  if (work === '') return '';

  // Park every emphasis run under a placeholder so the leftover sweep in step 2
  // cannot eat the asterisks we are about to (re)write.
  const runs: string[] = [];
  const park = (inner: string): string => {
    runs.push(inner);
    return `${BOLD_OPEN}${runs.length - 1}${BOLD_CLOSE}`;
  };

  work = work.replace(/\*\*([\s\S]*?)\*\*/g, (_match, inner: string) => park(inner));
  work = work.replace(/\*([^*\n]+)\*/g, (_match, inner: string) => park(inner));
  work = work.replace(/\*/g, '');
  work = work.replace(BOLD_TOKEN_RE, (_match, index: string) => {
    const inner = runs[Number(index)];
    return inner === undefined ? '' : `**${inner}**`;
  });

  work = work.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  work = work.replace(/\s*\.{3,}$/, ELLIPSIS);
  return work.trim();
}

/* ------------------------------------------------------------------ */
/* parsing                                                             */
/* ------------------------------------------------------------------ */

function extractArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      return extractArray(JSON.parse(raw) as unknown);
    } catch {
      return [];
    }
  }
  const record = asRecord(raw);
  if (!record) return [];
  for (const key of ['data', 'models', 'results', 'items']) {
    const candidate = record[key];
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function parseModel(entry: unknown): CatalogModel | undefined {
  const record = asRecord(entry);
  if (!record) return undefined;
  const id = asString(record['id'])?.trim();
  if (id === undefined || id === '') return undefined;

  const topProvider = asRecord(record['top_provider']) ?? {};
  const architecture = asRecord(record['architecture']) ?? {};
  const pricingRaw = asRecord(record['pricing']) ?? {};

  const pricing: ModelPricing = {
    prompt: asPriceString(pricingRaw['prompt']),
    completion: asPriceString(pricingRaw['completion']),
    request: asPriceString(pricingRaw['request']),
    image: asPriceString(pricingRaw['image']),
    inputCacheRead: asPriceString(pricingRaw['input_cache_read']),
    inputCacheWrite: asPriceString(pricingRaw['input_cache_write']),
  };

  const description = asString(record['description']) ?? '';
  const withoutTilde = id.startsWith('~') ? id.slice(1) : id;
  const slashIndex = withoutTilde.indexOf('/');
  const promptPrice = priceToNumber(pricing.prompt);
  const completionPrice = priceToNumber(pricing.completion);

  return {
    id,
    name: asString(record['name'])?.trim() ?? id,
    description,
    cleanDescription: sanitizeDescription(description),
    contextLength:
      asPositiveNumber(record['context_length']) ?? asPositiveNumber(topProvider['context_length']),
    maxCompletionTokens: asPositiveNumber(topProvider['max_completion_tokens']),
    pricing,
    supportedParameters: asStringArray(record['supported_parameters']),
    inputModalities: asStringArray(architecture['input_modalities']),
    outputModalities: asStringArray(architecture['output_modalities']),
    free: id.endsWith(':free'),
    vendor: slashIndex > 0 ? withoutTilde.slice(0, slashIndex) : undefined,
    tildePrefixed: id.startsWith('~'),
    zeroPriced: promptPrice === 0 && completionPrice === 0,
    isFreeFlag: typeof record['isFree'] === 'boolean' ? (record['isFree'] as boolean) : undefined,
  };
}

/**
 * Lenient parse of a /models payload.
 *
 * Accepts `{data:[...]}`, `{models:[...]}`, a bare array, or the JSON text of
 * any of those. Entries that are not objects, or carry no usable id, are
 * skipped rather than fatal. Duplicate ids keep the first occurrence.
 */
export function parseModels(raw: unknown): CatalogModel[] {
  const entries = extractArray(raw);
  const seen = new Set<string>();
  const out: CatalogModel[] = [];
  for (const entry of entries) {
    const model = parseModel(entry);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* lint                                                                */
/* ------------------------------------------------------------------ */

/**
 * Report metadata quality problems across the whole catalog.
 *
 * Rules were derived from a real 349-model /models response; see README.md.
 */
export function lintCatalog(models: readonly CatalogModel[]): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const model of models) {
    if (hasSingleAsteriskEmphasis(model.description)) {
      issues.push({
        modelId: model.id,
        issue: 'single-asterisk-markdown',
        detail: `single '*' emphasis found; repaired preview: ${preview(model.cleanDescription, 90)}`,
      });
    }
    if (model.vendor !== undefined && !VENDOR_PREFIX_RE.test(model.name)) {
      issues.push({
        modelId: model.id,
        issue: 'missing-vendor-prefix',
        detail: `name "${model.name}" has no "<vendor>: " prefix (vendor from id: ${model.vendor})`,
      });
    }
    if (model.tildePrefixed) {
      issues.push({
        modelId: model.id,
        issue: 'tilde-prefixed-id',
        detail: `alias id; concrete form would be "${model.id.slice(1)}"`,
      });
    }
    if (model.description.trim() === '') {
      issues.push({ modelId: model.id, issue: 'empty-description', detail: 'description is empty' });
    } else if (isTruncatedText(model.description)) {
      issues.push({
        modelId: model.id,
        issue: 'truncated-description',
        detail: `ends mid-sentence: ${preview(model.description, 60)}`,
      });
    }
    if (model.contextLength === undefined) {
      issues.push({
        modelId: model.id,
        issue: 'missing-context-length',
        detail: 'no usable context_length on the model or its top_provider',
      });
    }
  }
  return issues;
}

export function summarizeLint(issues: readonly LintIssue[]): Record<LintIssueKind, number> {
  const counts = {
    'single-asterisk-markdown': 0,
    'missing-vendor-prefix': 0,
    'tilde-prefixed-id': 0,
    'truncated-description': 0,
    'empty-description': 0,
    'missing-context-length': 0,
  } satisfies Record<LintIssueKind, number>;
  for (const issue of issues) counts[issue.issue] += 1;
  return counts;
}

/* ------------------------------------------------------------------ */
/* selection + formatting                                              */
/* ------------------------------------------------------------------ */

/** Models whose id carries the ':free' suffix, widest context first. */
export function filterFree(models: readonly CatalogModel[]): CatalogModel[] {
  return models
    .filter((model) => model.free)
    .sort((a, b) => (b.contextLength ?? 0) - (a.contextLength ?? 0) || a.id.localeCompare(b.id));
}

/**
 * Resolve a user-typed model reference: exact id, then case-insensitive,
 * then unique suffix / substring match. Returns undefined when ambiguous.
 */
export function findModel(models: readonly CatalogModel[], query: string): CatalogModel | undefined {
  const needle = query.trim();
  if (needle === '') return undefined;
  const exact = models.find((m) => m.id === needle);
  if (exact) return exact;
  const lower = needle.toLowerCase();
  const insensitive = models.find((m) => m.id.toLowerCase() === lower);
  if (insensitive) return insensitive;
  const partial = models.filter(
    (m) => m.id.toLowerCase().includes(lower) || m.name.toLowerCase() === lower,
  );
  return partial.length === 1 ? partial[0] : undefined;
}

export function suggestModels(models: readonly CatalogModel[], query: string, limit = 5): string[] {
  const lower = query.trim().toLowerCase();
  if (lower === '') return [];
  const out: string[] = [];
  for (const model of models) {
    if (model.id.toLowerCase().includes(lower) || model.name.toLowerCase().includes(lower)) {
      out.push(model.id);
      if (out.length >= limit) break;
    }
  }
  return out;
}

function preview(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}${ELLIPSIS}`;
}

export function formatTokens(value: number | undefined): string {
  if (value === undefined) return 'unknown';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}K`;
  return String(value);
}

/** Gateway prices are per token; humans read per million tokens. */
export function formatPricePerMillion(value: string | undefined): string {
  const parsed = priceToNumber(value);
  if (parsed === undefined) return 'unknown';
  if (parsed === 0) return '$0';
  const perMillion = parsed * 1_000_000;
  const digits = perMillion >= 1 ? 2 : 4;
  let text = perMillion.toFixed(digits);
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');
  return `$${text}/M`;
}

/** Single-model detail block used by !modelinfo. */
export function formatModelInfo(model: CatalogModel): string {
  const lines: string[] = [];
  lines.push(`**${model.name}**`);
  lines.push(`id: \`${model.id}\``);
  lines.push(`free: ${model.free ? 'yes (:free)' : model.zeroPriced ? 'no (but priced at 0)' : 'no'}`);
  lines.push(`context: ${formatTokens(model.contextLength)} tokens`);
  lines.push(`max completion: ${formatTokens(model.maxCompletionTokens)} tokens`);
  lines.push(
    `pricing: prompt ${formatPricePerMillion(model.pricing.prompt)} | completion ${formatPricePerMillion(
      model.pricing.completion,
    )}`,
  );
  lines.push(
    `parameters: ${model.supportedParameters.length > 0 ? model.supportedParameters.join(', ') : 'unknown'}`,
  );
  if (model.inputModalities.length > 0) lines.push(`input: ${model.inputModalities.join(', ')}`);
  if (model.tildePrefixed) lines.push("note: '~' alias id, resolves to a moving target upstream");
  const description = model.cleanDescription;
  if (description !== '') lines.push('', preview(description, 400));
  return lines.join('\n');
}

/** Compact list used by !freemodels. */
export function formatFreeList(models: readonly CatalogModel[]): string {
  if (models.length === 0) return 'No :free models are currently listed by the gateway.';
  const lines = models.map(
    (model, index) => `${index + 1}. \`${model.id}\` - ${formatTokens(model.contextLength)} ctx`,
  );
  return [`**${models.length} free model(s)**`, ...lines].join('\n');
}

/** Grouped report used by !lint. */
export function formatLintReport(
  issues: readonly LintIssue[],
  totalModels: number,
  limit = 10,
): string {
  if (issues.length === 0) return `Catalog clean: no metadata issues across ${totalModels} models.`;
  const counts = summarizeLint(issues);
  const lines: string[] = [`**${issues.length} issue(s) across ${totalModels} models**`];
  for (const [kind, count] of Object.entries(counts)) {
    if (count > 0) lines.push(`- ${count} x ${LINT_ISSUE_LABELS[kind as LintIssueKind]}`);
  }
  lines.push('', `First ${Math.min(limit, issues.length)}:`);
  for (const issue of issues.slice(0, limit)) {
    lines.push(`- \`${issue.modelId}\` [${issue.issue}] ${preview(issue.detail, 120)}`);
  }
  if (issues.length > limit) lines.push(`... and ${issues.length - limit} more.`);
  return lines.join('\n');
}
