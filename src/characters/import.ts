import type { CharacterRecord } from './catalog.js';

/**
 * Batch import layer for character personas. Sits on top of
 * {@link CharacterCatalog.save} — it never writes files itself, it only
 * validates, dedups, resolves conflicts and reports per-item outcomes.
 */

export interface CharacterImportItem {
  id?: string;
  name: string;
  prompt: string;
  source?: string;
  expectedRevision?: string;
}

export interface CharacterImportSkipped {
  index: number;
  name?: string;
  reason: string;
}

export interface CharacterImportFailed {
  index: number;
  name?: string;
  error: string;
}

export interface CharacterImportReport {
  total: number;
  imported: CharacterRecord[];
  skipped: CharacterImportSkipped[];
  failed: CharacterImportFailed[];
}

export interface CharacterImportOptions {
  /** Run every validation + conflict check but never call catalog.save. */
  dryRun?: boolean;
  /** What to do when the resolved id already exists. Default: 'skip'. */
  onConflict?: 'skip' | 'overwrite';
}

/** Minimal catalog surface used by the importer; the real CharacterCatalog satisfies it. */
export interface CharacterCatalogLike {
  get(id: string): Promise<CharacterRecord | undefined>;
  save(input: {
    id?: string;
    name: string;
    prompt: string;
    source?: string;
    expectedRevision?: string;
  }): Promise<CharacterRecord>;
}

/**
 * The real catalog also exposes list(); when present we snapshot it once per
 * batch instead of calling get() per item (get() re-reads the whole directory,
 * which is O(n^2) for large batches). Structurally typed stubs never declare
 * the private #dir of CharacterCatalog, so an object with list() here is
 * always the real catalog or an equivalent — never an accidental fake.
 */
interface ListableCatalog extends CharacterCatalogLike {
  list(): Promise<CharacterRecord[]>;
}

function hasList(catalog: CharacterCatalogLike): catalog is ListableCatalog {
  return typeof (catalog as Partial<ListableCatalog>).list === 'function';
}

/** Hard cap on one batch; exceeding it is a programming/abuse error, so we throw. */
export const MAX_IMPORT_BATCH = 200;
export const MAX_NAME_LENGTH = 100;
export const MIN_PROMPT_LENGTH = 20;
export const MAX_PROMPT_LENGTH = 100_000;

// Any C0 control char or DEL.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
// Control chars minus \t \n \r — prompts are markdown and may be multiline,
// but names must stay single-line and clean.
const PROMPT_CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/**
 * Same normalization catalog.save() applies to derive the on-disk id:
 * lowercase, collapse runs of disallowed characters into '-', trim edge '-'.
 */
export function safeCharacterId(item: Pick<CharacterImportItem, 'id' | 'name'>): string {
  const raw = typeof item.id === 'string' && item.id.length > 0 ? item.id : item.name;
  if (typeof raw !== 'string') return '';
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff_-]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Returns a list of human-readable validation problems; empty means the item is valid. */
export function validateCharacterImportItem(item: CharacterImportItem | undefined | null): string[] {
  if (!item || typeof item !== 'object') return ['item is not an object'];
  const reasons: string[] = [];

  const { name, prompt } = item;
  if (typeof name !== 'string' || name.trim().length === 0) {
    reasons.push('name is required');
  } else {
    if (name.length > MAX_NAME_LENGTH) reasons.push(`name exceeds ${MAX_NAME_LENGTH} characters`);
    if (CONTROL_CHARS.test(name)) reasons.push('name contains control characters');
  }

  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    reasons.push('prompt is required');
  } else {
    const trimmed = prompt.trim().length;
    if (trimmed < MIN_PROMPT_LENGTH) reasons.push(`prompt is shorter than ${MIN_PROMPT_LENGTH} characters`);
    if (prompt.length > MAX_PROMPT_LENGTH) reasons.push(`prompt exceeds ${MAX_PROMPT_LENGTH} characters`);
    if (PROMPT_CONTROL_CHARS.test(prompt)) reasons.push('prompt contains control characters');
  }

  return reasons;
}

export class CharacterImporter {
  readonly #catalog: CharacterCatalogLike;

  constructor(deps: { catalog: CharacterCatalogLike }) {
    this.#catalog = deps.catalog;
  }

  async importAll(
    items: CharacterImportItem[],
    options: CharacterImportOptions = {},
  ): Promise<CharacterImportReport> {
    if (!Array.isArray(items)) throw new TypeError('items must be an array');
    if (items.length > MAX_IMPORT_BATCH) {
      throw new Error(`import batch too large: ${items.length} items exceeds the cap of ${MAX_IMPORT_BATCH}`);
    }
    const dryRun = options.dryRun === true;
    const onConflict = options.onConflict === 'overwrite' ? 'overwrite' : 'skip';

    const report: CharacterImportReport = { total: items.length, imported: [], skipped: [], failed: [] };
    const seenIds = new Map<string, number>();
    // One directory snapshot for the whole batch when the catalog supports it;
    // ids written by this batch are added as we go so it never goes stale.
    const knownIds = hasList(this.#catalog)
      ? new Set((await this.#catalog.list().catch(() => [])).map((record) => record.id))
      : null;

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index] as CharacterImportItem | undefined;
      const label = typeof item?.name === 'string' && item.name.trim().length > 0 ? item.name.trim() : undefined;

      const problems = validateCharacterImportItem(item);
      if (problems.length > 0) {
        report.skipped.push({ index, ...(label ? { name: label } : {}), reason: problems.join('; ') });
        continue;
      }

      const safeId = safeCharacterId(item as CharacterImportItem);
      if (!safeId) {
        report.skipped.push({ index, ...(label ? { name: label } : {}), reason: 'resolved character id is empty' });
        continue;
      }

      if (seenIds.has(safeId)) {
        report.skipped.push({ index, ...(label ? { name: label } : {}), reason: 'duplicate-in-batch' });
        continue;
      }
      seenIds.set(safeId, index);

      const exists = knownIds
        ? knownIds.has(safeId)
        : (await this.#catalog.get(safeId).catch(() => undefined)) !== undefined;
      if (exists && onConflict === 'skip') {
        report.skipped.push({ index, ...(label ? { name: label } : {}), reason: 'exists' });
        continue;
      }

      if (dryRun) {
        report.imported.push(previewRecord(item as CharacterImportItem, safeId));
        continue;
      }

      try {
        const saved = await this.#catalog.save({
          id: item?.id,
          name: (item as CharacterImportItem).name,
          prompt: (item as CharacterImportItem).prompt,
          ...(item?.source !== undefined ? { source: item.source } : {}),
          ...(item?.expectedRevision !== undefined ? { expectedRevision: item.expectedRevision } : {}),
        });
        report.imported.push(saved);
        knownIds?.add(saved.id);
        knownIds?.add(safeId);
      } catch (error) {
        report.failed.push({
          index,
          ...(label ? { name: label } : {}),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return report;
  }
}

/** Convenience wrapper around {@link CharacterImporter.importAll}. */
export function importCharacters(
  catalog: CharacterCatalogLike,
  items: CharacterImportItem[],
  options?: CharacterImportOptions,
): Promise<CharacterImportReport> {
  return new CharacterImporter({ catalog }).importAll(items, options);
}

/**
 * Stand-in record for dry runs: shaped like a CharacterRecord but never
 * persisted. `revision` is empty to signal "preview only".
 */
function previewRecord(item: CharacterImportItem, safeId: string): CharacterRecord {
  return {
    id: safeId,
    name: item.name.trim(),
    promptFile: `${safeId}.md`,
    prompt: item.prompt,
    tags: [],
    ...(item.source !== undefined ? { source: item.source } : {}),
    updatedAt: new Date().toISOString(),
    revision: '',
  };
}
