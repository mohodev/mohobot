import { vi } from 'vitest';
import type { BotSnapshot, OpsAudit, OpsSession, OpsTask } from '../lib/types';

/**
 * Shared test fixtures and fetch stubbing for page tests (frozen contract).
 *
 * Page tests should import from here rather than re-declaring fixtures so the
 * whole suite stays consistent and easy to update.
 */

export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export interface RouteTable { [key: string]: unknown }

/**
 * Installs a `fetch` mock that routes by "METHOD /path" (query string ignored).
 * Missing routes return 404 so tests fail loudly instead of silently.
 */
export function mockFetch(routes: RouteTable) {
  return vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const key = `${method} ${url.pathname}`;
    const hit = routes[key];
    if (hit === undefined) return jsonResponse({ error: `no mock for ${key}` }, 404);
    if (typeof hit === 'function') return (hit as (init?: RequestInit) => Response | Promise<Response>)(init);
    return jsonResponse(hit);
  });
}

export function botFixture(overrides: Partial<BotSnapshot> = {}): BotSnapshot {
  return {
    id: 'moho',
    name: 'MohoBot',
    adapter: 'discord',
    provider: 'openai',
    model: 'gpt-4o-mini',
    running: true,
    sessions: 3,
    gateway: { connected: true, ping: 42, reconnects: 0 },
    ...overrides,
  };
}

export function sessionFixture(overrides: Partial<OpsSession> = {}): OpsSession {
  return {
    id: 'session:moho:chan-1',
    botId: 'moho',
    channelId: 'chan-1',
    userId: 'user-1',
    updatedAt: Date.now(),
    messageCount: 12,
    deletedCount: 1,
    contentLength: 840,
    summaryHash: 'abcd1234',
    ...overrides,
  };
}

export function auditFixture(overrides: Partial<OpsAudit> = {}): OpsAudit {
  return {
    id: 'audit-1',
    at: new Date().toISOString(),
    actor: 'bootstrap',
    action: 'runtime.status',
    outcome: 'allowed',
    detail: 'ok',
    method: 'GET',
    path: '/api/status',
    status: 200,
    ...overrides,
  };
}

export function taskFixture(overrides: Partial<OpsTask> = {}): OpsTask {
  return {
    id: 'task-1',
    name: 'world.tick',
    kind: 'interval',
    state: 'running',
    createdAt: Date.now() - 60_000,
    runs: 5,
    errors: 0,
    ...overrides,
  };
}

/** Seeds sessionStorage with the permission list pages read for gating. */
export function seedPermissions(permissions: string[]): void {
  window.sessionStorage.setItem('moho-admin-permissions', JSON.stringify(permissions));
}
