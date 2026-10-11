/**
 * Manual VCPedia song sync: `npx tsx scripts/sync-songs.ts [--limit N]`.
 *
 * Lists Category:洛天依歌曲, fetches each page's wikitext, parses song
 * records and upserts them into the kv-backed song store. Long pages stream
 * progress to stdout. A `--limit N` cap exists for smoke-testing the chain
 * against the first N titles before the multi-thousand full run.
 *
 * Mirrors upstream `scripts/sync_vcpedia.py`. Same sources, same fields.
 */

import path from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { createNullLogger } from '../src/core/logger.js';
import { SongStore } from '../src/songs/database.js';
import { DEFAULT_VCPEDIA_CONFIG, syncVcpedia } from '../src/songs/vcpedia.js';

const rootDir = process.env.MOHO_ROOT ?? process.cwd();

async function main(): Promise<void> {
  const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
  const limit = limitArg ? Number.parseInt(limitArg.split('=')[1] ?? '', 10) : 0;

  const storage = new SqliteStorage({ path: path.join(rootDir, 'data', 'mohobot.db'), logger: createNullLogger() });
  await storage.init();
  const store = new SongStore({ storage, logger: createNullLogger() });

  const config = { ...DEFAULT_VCPEDIA_CONFIG };
  const started = Date.now();
  console.log(`syncing ${config.category} from ${config.baseUrl}${Number.isFinite(limit) && limit > 0 ? ` (first ${limit} titles)` : ''} ...`);

  const result = await syncVcpedia(config, (detail) => store.upsert(detail), fetch, (done, total) => {
    if (done % 100 === 0 || done === total) console.log(`  ${done}/${total}`);
  }, Number.isFinite(limit) && limit > 0 ? limit : 0);
  const indexed = await store.reload();
  const elapsed = Math.round((Date.now() - started) / 1000);
  console.log(`done in ${elapsed}s: listed ${result.listed}, added ${result.added.length}, skipped ${result.skipped}, failed ${result.failed.length}, indexed ${indexed}`);
  for (const failure of result.failed.slice(0, 10)) {
    console.log(`  failed: ${failure.title} (${failure.reason})`);
  }
  await storage.close();
}

await main();
