import type { Logger } from '../core/logger.js';
import { ModelCatalogStore, type CatalogModel, type ModelCatalogSnapshot } from './model-catalog.js';

export interface CatalogFetcher { fetchPage(page: number): Promise<{ models: CatalogModel[]; totalModels?: number; freeEndpointCount?: number }>; }
export interface CatalogRefreshResult { ok: boolean; pages: number; models: number; snapshot: ModelCatalogSnapshot; error?: string; }

/** Optional, best-effort catalog refresh. Runtime never depends on it. */
export class ModelCatalogRefresher {
  readonly #store: ModelCatalogStore;
  readonly #logger: Logger;
  constructor(rootDir: string, logger: Logger) { this.#store = new ModelCatalogStore(rootDir); this.#logger = logger.child({ component: 'model-catalog' }); }

  async refresh(fetcher: CatalogFetcher, maxPages = 20): Promise<CatalogRefreshResult> {
    const all: CatalogModel[] = [];
    let totalModels: number | undefined;
    let freeEndpointCount: number | undefined;
    let pages = 0;
    try {
      for (let page = 1; page <= maxPages; page += 1) {
        const result = await fetcher.fetchPage(page);
        pages = page;
        all.push(...result.models);
        totalModels ??= result.totalModels;
        freeEndpointCount ??= result.freeEndpointCount;
        if (result.models.length === 0) break;
      }
      if (all.length === 0) throw new Error('catalog returned no models');
      const snapshot = await this.#store.merge(all, { totalModels, freeEndpointCount, source: 'dynamic-fetch' });
      return { ok: true, pages, models: all.length, snapshot };
    } catch (error) {
      const snapshot = await this.#store.get();
      this.#logger.warn({ err: error }, 'model catalog refresh failed; keeping last good snapshot');
      return { ok: false, pages: 0, models: snapshot.models.length, snapshot, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
