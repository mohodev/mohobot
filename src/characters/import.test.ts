import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CharacterCatalog, type CharacterRecord } from './catalog.js';
import {
  CharacterImporter,
  MAX_IMPORT_BATCH,
  importCharacters,
  safeCharacterId,
  type CharacterCatalogLike,
  type CharacterImportItem,
} from './import.js';

let root = '';

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = '';
});

async function makeCatalog(): Promise<CharacterCatalog> {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'characters-import-'));
  return new CharacterCatalog(root);
}

function item(name: string, overrides: Partial<CharacterImportItem> = {}): CharacterImportItem {
  return { name, prompt: `A sufficiently long character prompt for ${name}.`, ...overrides };
}

describe('CharacterImporter happy path', () => {
  it('imports all valid items and writes them to disk', async () => {
    const catalog = await makeCatalog();
    const report = await new CharacterImporter({ catalog }).importAll([
      item('Alice'),
      item('Bob', { id: 'bobby' }),
      item('爱丽丝'),
    ]);

    expect(report.total).toBe(3);
    expect(report.imported).toHaveLength(3);
    expect(report.skipped).toHaveLength(0);
    expect(report.failed).toHaveLength(0);
    expect(report.imported.map((r) => r.id)).toEqual(['alice', 'bobby', '爱丽丝']);

    const stored = await catalog.list();
    expect(stored).toHaveLength(3);
    expect(stored.map((r) => r.id).sort()).toEqual(['alice', 'bobby', '爱丽丝'].sort());
    for (const record of report.imported) {
      expect(record.revision).toHaveLength(64);
      expect(await fs.stat(path.join(root, 'data', 'characters', record.promptFile))).toBeTruthy();
    }
  });

  it('derives the same safe id as catalog.save (normalization parity)', () => {
    expect(safeCharacterId({ name: 'Alice Smith!' })).toBe('alice-smith');
    expect(safeCharacterId({ id: '  Weird  ID  ', name: 'ignored' })).toBe('weird-id');
    expect(safeCharacterId({ name: '爱丽丝' })).toBe('爱丽丝');
    expect(safeCharacterId({ name: '!!!' })).toBe('');
  });
});

describe('CharacterImporter validation', () => {
  it('skips invalid items with reasons but still imports valid siblings', async () => {
    const catalog = await makeCatalog();
    const items: CharacterImportItem[] = [
      { name: '', prompt: 'A sufficiently long prompt that should import fine.' }, // empty name
      item('Shorty', { prompt: 'too short' }), // prompt < 20 chars
      item('Beepy', { prompt: 'A sufficiently long prompt with a \u0007 bell char inside.' }), // control char
      item('Null\u0000Name'), // null byte in name
      item('X'.repeat(101)), // name too long
      item('Good One'), // valid
    ];
    const report = await importCharacters(catalog, items);

    expect(report.total).toBe(6);
    expect(report.imported).toHaveLength(1);
    expect(report.imported[0]?.name).toBe('Good One');
    expect(report.failed).toHaveLength(0);
    expect(report.skipped.map((s) => s.index)).toEqual([0, 1, 2, 3, 4]);
    expect(report.skipped[0]?.reason).toContain('name is required');
    expect(report.skipped[1]?.reason).toContain('shorter than 20');
    expect(report.skipped[2]?.reason).toContain('control characters');
    expect(report.skipped[3]?.reason).toContain('control characters');
    expect(report.skipped[4]?.reason).toContain('exceeds 100 characters');

    expect(await catalog.list()).toHaveLength(1);
  });

  it('allows multiline prompts (newline/tab are not rejected)', async () => {
    const catalog = await makeCatalog();
    const report = await importCharacters(catalog, [
      item(' multiline ', { prompt: 'Line one of the prompt.\n\tLine two of the prompt.\n' }),
    ]);
    expect(report.imported).toHaveLength(1);
    expect((await catalog.get('multiline'))?.prompt).toContain('Line two');
  });

  it('skips items whose name resolves to an empty id', async () => {
    const catalog = await makeCatalog();
    const report = await importCharacters(catalog, [
      { name: '!!!', prompt: 'A sufficiently long prompt that cannot resolve to an id.' },
    ]);
    expect(report.imported).toHaveLength(0);
    expect(report.skipped[0]?.reason).toContain('empty');
  });
});

describe('CharacterImporter dedup and conflicts', () => {
  it('marks later same-id items as duplicate-in-batch', async () => {
    const catalog = await makeCatalog();
    const report = await importCharacters(catalog, [
      item('Alice Smith'),
      item('alice  SMITH!'), // resolves to the same safe id
      item('Alice Smith', { id: 'alice-smith' }), // explicit same id
      item('Bob'),
    ]);

    expect(report.imported.map((r) => r.id)).toEqual(['alice-smith', 'bob']);
    expect(report.skipped).toHaveLength(2);
    expect(report.skipped.every((s) => s.reason === 'duplicate-in-batch')).toBe(true);
    expect(report.skipped.map((s) => s.index)).toEqual([1, 2]);
    expect(await catalog.list()).toHaveLength(2);
  });

  it('skips existing characters by default (onConflict: skip)', async () => {
    const catalog = await makeCatalog();
    await catalog.save({ id: 'alice', name: 'Alice', prompt: 'The original alice prompt, long enough.' });

    const report = await importCharacters(catalog, [
      item('Alice', { prompt: 'A brand new prompt that must not overwrite anything.' }),
      item('Bob'),
    ]);

    expect(report.imported.map((r) => r.id)).toEqual(['bob']);
    expect(report.skipped).toEqual([{ index: 0, name: 'Alice', reason: 'exists' }]);
    expect((await catalog.get('alice'))?.prompt).toContain('original');
  });

  it('overwrites existing characters with onConflict: overwrite', async () => {
    const catalog = await makeCatalog();
    await catalog.save({ id: 'alice', name: 'Alice', prompt: 'The original alice prompt, long enough.' });

    const report = await importCharacters(
      catalog,
      [item('Alice', { prompt: 'An overwritten alice prompt from the batch import.' })],
      { onConflict: 'overwrite' },
    );

    expect(report.imported).toHaveLength(1);
    expect(report.skipped).toHaveLength(0);
    expect((await catalog.get('alice'))?.prompt).toContain('overwritten');
  });

  it('isolates an expectedRevision conflict into failed[] with overwrite', async () => {
    const catalog = await makeCatalog();
    const saved = await catalog.save({ id: 'alice', name: 'Alice', prompt: 'The original alice prompt, long enough.' });

    const report = await importCharacters(
      catalog,
      [
        item('Alice', {
          prompt: 'A stale update that must never overwrite the current content.',
          expectedRevision: `${saved.revision}0`,
        }),
        item('Bob'),
      ],
      { onConflict: 'overwrite' },
    );

    expect(report.failed).toEqual([{ index: 0, name: 'Alice', error: 'character revision conflict' }]);
    expect(report.imported.map((r) => r.id)).toEqual(['bob']);
    expect((await catalog.get('alice'))?.prompt).toContain('original');
  });
});

describe('CharacterImporter dry run', () => {
  it('reports what would happen without writing any files', async () => {
    const catalog = await makeCatalog();
    await catalog.save({ id: 'alice', name: 'Alice', prompt: 'The original alice prompt, long enough.' });

    const report = await importCharacters(
      catalog,
      [
        item('Alice', { prompt: 'A new prompt that must never touch the disk in a dry run.' }),
        item('Bob'),
        item('Shorty', { prompt: 'nope' }),
      ],
      { dryRun: true },
    );

    expect(report.total).toBe(3);
    expect(report.imported.map((r) => r.id)).toEqual(['bob']);
    expect(report.imported[0]?.revision).toBe(''); // preview marker
    expect(report.skipped).toEqual([
      { index: 0, name: 'Alice', reason: 'exists' },
      { index: 2, name: 'Shorty', reason: 'prompt is shorter than 20 characters' },
    ]);
    expect(report.failed).toHaveLength(0);

    const stored = await catalog.list();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.id).toBe('alice');
    expect(stored[0]?.prompt).toContain('original');
  });

  it('detects conflicts in dry run with onConflict: overwrite as would-import', async () => {
    const catalog = await makeCatalog();
    const before = await catalog.save({ id: 'alice', name: 'Alice', prompt: 'The original alice prompt, long enough.' });

    const report = await importCharacters(
      catalog,
      [item('Alice', { prompt: 'A dry-run overwrite preview prompt for alice here.' })],
      { dryRun: true, onConflict: 'overwrite' },
    );

    expect(report.imported).toHaveLength(1);
    expect(report.imported[0]?.id).toBe('alice');
    expect((await catalog.get('alice'))?.revision).toBe(before.revision); // untouched
  });
});

describe('CharacterImporter failure isolation and limits', () => {
  it('captures per-item save errors into failed[] without aborting the batch', async () => {
    const saved: CharacterRecord[] = [];
    const stub: CharacterCatalogLike = {
      async get() {
        return undefined;
      },
      async save(input) {
        if ((input.id ?? input.name) === 'boom') throw new Error('disk on fire');
        const record: CharacterRecord = {
          id: (input.id ?? input.name).toLowerCase(),
          name: input.name,
          promptFile: `${(input.id ?? input.name).toLowerCase()}.md`,
          prompt: input.prompt,
          tags: [],
          updatedAt: new Date().toISOString(),
          revision: 'x'.repeat(64),
        };
        saved.push(record);
        return record;
      },
    };

    const report = await importCharacters(stub, [item('Ok One'), item('Boom', { id: 'boom' }), item('Ok Two')]);

    expect(report.imported.map((r) => r.id)).toEqual(['ok one', 'ok two']);
    expect(report.failed).toEqual([{ index: 1, name: 'Boom', error: 'disk on fire' }]);
    expect(saved).toHaveLength(2);
  });

  it('survives a catalog.get that throws (treated as no existing record)', async () => {
    const catalog = await makeCatalog();
    const flaky: CharacterCatalogLike = {
      async get() {
        throw new Error('get exploded');
      },
      save: (input) => catalog.save(input),
    };
    const report = await importCharacters(flaky, [item('Alice')]);
    expect(report.imported).toHaveLength(1);
    expect((await catalog.get('alice'))?.name).toBe('Alice');
  });

  it('throws when the batch exceeds the cap', async () => {
    const catalog = await makeCatalog();
    const items = Array.from({ length: MAX_IMPORT_BATCH + 1 }, (_, i) => item(`Char ${i}`));
    await expect(importCharacters(catalog, items)).rejects.toThrow(/batch too large/);
    expect(await catalog.list()).toHaveLength(0);
  });

  it('accepts exactly the cap without throwing', async () => {
    // In-memory stub: this test is about the batch-size boundary, not disk I/O.
    const stub: CharacterCatalogLike = {
      async get() {
        return undefined;
      },
      async save(input) {
        const id = safeCharacterId(input);
        return {
          id,
          name: input.name,
          promptFile: `${id}.md`,
          prompt: input.prompt,
          tags: [],
          updatedAt: new Date().toISOString(),
          revision: 'x'.repeat(64),
        };
      },
    };
    const items = Array.from({ length: MAX_IMPORT_BATCH }, (_, i) => item(`Char ${i}`));
    const report = await importCharacters(stub, items);
    expect(report.total).toBe(MAX_IMPORT_BATCH);
    expect(report.imported).toHaveLength(MAX_IMPORT_BATCH);
    expect(report.skipped).toHaveLength(0);
    expect(report.failed).toHaveLength(0);
  });
});
