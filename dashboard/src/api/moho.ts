// MohoBot Admin API client, generated from docs/openapi.yaml.
//
// Generated with: npm run generate:api
//   openapi-ts -i ../docs/openapi.yaml -o src/api/generated/moho -c @hey-api/client-axios
//
// Wiring matches the AstrBot client in ./v1.ts: the generated client reuses the
// global axios instance from ./http, so the session-token interceptor installed
// by setupHttpClient() (Bearer token from sessionStorage) applies here too.
// Responses follow the MohoBot envelope { ok: true, ...payload } /
// { ok: false, error: string } (see docs/OPENAPI.md); response schemas in the
// spec are skeleton-level, so callers read payload fields off the envelope.
import * as mohoApi from './generated/moho';
import { client as mohoClient } from './generated/moho';
import { httpClient } from './http';

mohoClient.setConfig({
  axios: httpClient,
  throwOnError: true,
});

export * from './generated/moho';
export { mohoApi, mohoClient };

export type MohoEnvelope<T = Record<string, unknown>> = {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
} & T;

/**
 * Issue a confirmation nonce for a protected write, mirroring the React
 * dashboard's confirmedRequest() (dashboard-react-backup/src/lib/api.ts):
 * POST /api/confirmations { method, path, body } -> { ok, confirmation: { nonce } }.
 */
export async function issueConfirmation(
  method: string,
  path: string,
  body: unknown,
): Promise<string> {
  const res = await mohoApi.confirmationIssue({
    body: { method, path, body },
  });
  const data = (res.data ?? {}) as Record<string, unknown>;
  const confirmation = data.confirmation as Record<string, unknown> | undefined;
  const nonce = confirmation?.nonce ?? data.nonce;
  if (typeof nonce !== 'string' || !nonce) {
    throw new Error('确认服务没有返回 nonce');
  }
  return nonce;
}

/**
 * Run a protected write behind the two-step confirmation: prompt the admin
 * to type "确认", issue a nonce for the target operation, then run the
 * request with the X-Admin-Confirmation header. `run` receives the header
 * to pass into the generated client call, e.g.
 *   confirmed('调整好感度', 'POST', '/api/affinity/adjust', payload,
 *     (headers) => mohoApi.affinityAdjust({ body: payload, headers }))
 */
export async function confirmed<T>(
  description: string,
  method: string,
  path: string,
  body: unknown,
  run: (headers: Record<string, string>) => Promise<T>,
): Promise<T> {
  const phrase = window.prompt(
    `${description}\n\n这是受保护的管理操作。输入“确认”继续：`,
  );
  if (phrase !== '确认') throw new Error('操作已取消');
  const nonce = await issueConfirmation(method, path, body);
  return run({ 'X-Admin-Confirmation': nonce });
}
