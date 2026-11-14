import { HttpError } from '../api-errors.js';
import type { OpsControlFacade } from '../ops-control.js';

export function intParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  if (!/^\d+$/.test(raw)) throw new HttpError(400, `invalid ${name}`);
  return Number(raw);
}

export function stringParam(url: URL, name: string): string | undefined {
  return url.searchParams.get(name) ?? undefined;
}

export function requireOps(ops: OpsControlFacade | undefined): OpsControlFacade {
  if (!ops) throw new HttpError(409, 'operations control unavailable');
  return ops;
}
