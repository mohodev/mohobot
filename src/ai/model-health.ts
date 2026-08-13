import type { Logger } from '../core/logger.js';
import type { CatalogModel, ModelCatalogSnapshot } from './model-catalog.js';

export interface ModelHealth { id: string; ok: boolean; checkedAt: string; latencyMs?: number; error?: string; }
export interface ModelHealthProbe { probe(model: CatalogModel): Promise<{ ok: boolean; latencyMs?: number; error?: string }>; }

/** Health is advisory; failed models are not deleted from the reference catalog. */
export async function checkCatalogModels(snapshot: ModelCatalogSnapshot, probe: ModelHealthProbe, logger: Logger, limit = 8): Promise<ModelHealth[]> {
  const selected = snapshot.models.filter((model) => model.freeEndpoint).slice(0, limit);
  const results = await Promise.all(selected.map(async (model): Promise<ModelHealth> => {
    try { const result = await probe.probe(model); return { id: model.id, checkedAt: new Date().toISOString(), ...result }; }
    catch (error) { logger.debug({ model: model.id, err: error }, 'model health probe failed'); return { id: model.id, ok: false, checkedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) }; }
  }));
  return results;
}
