import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { ROUTE_POLICIES, type RoutePolicy } from './route-policy.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

interface OpenApiOperation {
  operationId?: string;
  parameters?: Array<{ name: string; in: string; required?: boolean }>;
  'x-moho-action'?: string;
  'x-moho-permission'?: string | null;
  'x-moho-risk'?: string;
  'x-moho-confirmation'?: boolean;
  [key: string]: unknown;
}

interface OpenApiDocument {
  openapi: string;
  info?: { version?: string };
  paths?: Record<string, Record<string, OpenApiOperation>>;
  components?: { schemas?: Record<string, unknown> };
}

/** Expand one RoutePolicy into the (method, path-template) pairs it covers. */
function expandPolicy(policy: RoutePolicy): Array<{ method: string; segments: string[] }> {
  const source = policy.pattern.source
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .replace(/\\\//g, '/');
  const variants: string[] = [];
  if (source === '/api/world(?:/day-plan)?') {
    variants.push('/api/world', '/api/world/day-plan');
  } else if (source === '/api/world/(tick|events)') {
    variants.push('/api/world/tick', '/api/world/events');
  } else if (source === '/api/tasks/[^/]+/(pause|resume|run)') {
    variants.push('/api/tasks/{taskId}/pause', '/api/tasks/{taskId}/resume', '/api/tasks/{taskId}/run');
  } else {
    variants.push(source);
  }
  return variants.map((variant) => ({
    method: policy.method,
    // [^/]+ contains a '/', so placeholder it before splitting.
    segments: variant.replace(/\[\^\/\]\+/g, '\u0000').split('/').map((segment) => (segment === '\u0000' ? '{param}' : segment)),
  }));
}

function specMatches(specPath: string, segments: string[]): boolean {
  const specSegments = specPath.split('/');
  if (specSegments.length !== segments.length) return false;
  return specSegments.every((segment, index) => {
    const expected = segments[index]!;
    if (expected === '{param}') return segment.startsWith('{') && segment.endsWith('}');
    return segment === expected;
  });
}

const PRE_AUTH: Array<{ method: string; path: string }> = [
  { method: 'POST', path: '/api/auth/bootstrap/session' },
  { method: 'POST', path: '/api/auth/session' },
  { method: 'POST', path: '/api/auth/login' },
  { method: 'GET', path: '/api/setup/status' },
  { method: 'POST', path: '/api/setup/init' },
];

async function loadSpec(): Promise<OpenApiDocument> {
  const raw = await fs.readFile(path.join(repoRoot, 'docs', 'openapi.yaml'), 'utf8');
  return parseYaml(raw) as OpenApiDocument;
}

describe('OpenAPI contract', () => {
  it('parses as OpenAPI 3.0.3', async () => {
    const doc = await loadSpec();
    expect(doc.openapi).toBe('3.0.3');
    expect(doc.info?.version).toBe('1.0.0');
    expect(doc.paths).toBeDefined();
  });

  it('covers every route policy and pre-auth operation, and nothing else', async () => {
    const doc = await loadSpec();
    const specOps: Array<{ method: string; path: string }> = [];
    for (const [specPath, methods] of Object.entries(doc.paths ?? {})) {
      for (const method of Object.keys(methods)) specOps.push({ method: method.toUpperCase(), path: specPath });
    }
    // Every policy operation must be in the spec.
    let policyOpCount = 0;
    for (const policy of ROUTE_POLICIES) {
      for (const { method, segments } of expandPolicy(policy)) {
        policyOpCount += 1;
        const found = specOps.find((op) => op.method === method && specMatches(op.path, segments));
        expect(found, `${method} ${segments.join('/')} (action ${policy.action}) missing from docs/openapi.yaml`).toBeDefined();
      }
    }
    expect(policyOpCount).toBe(111);
    // Every pre-auth operation must be in the spec.
    for (const pre of PRE_AUTH) {
      expect(specOps).toContainEqual(pre);
    }
    // No extra operations: 111 policy ops + 5 pre-auth = 116.
    expect(specOps).toHaveLength(116);
    // /api/openapi.json itself is intentionally not an operation (docs/OPENAPI.md §3).
    expect(specOps.some((op) => op.path === '/api/openapi.json')).toBe(false);
  });

  it('matches policy permission, risk, action and confirmation on every operation', async () => {
    const doc = await loadSpec();
    for (const policy of ROUTE_POLICIES) {
      for (const { method, segments } of expandPolicy(policy)) {
        const entry = Object.entries(doc.paths ?? {}).find(
          ([specPath, methods]) => specMatches(specPath, segments) && methods[method.toLowerCase()],
        );
        expect(entry, `${method} ${segments.join('/')}`).toBeDefined();
        const op = entry![1][method.toLowerCase()]!;
        expect(op['x-moho-permission'] ?? null).toBe(policy.permission ?? null);
        expect(op['x-moho-risk']).toBe(policy.risk);
        expect(op['x-moho-action']).toBe(policy.action);
        expect(op['x-moho-confirmation']).toBe(policy.confirmation);
      }
    }
    for (const policy of ROUTE_POLICIES) {
      if (policy.risk === 'dangerous') expect(policy.confirmation).toBe(true);
    }
  });

  it('has unique operationIds and declares every path parameter', async () => {
    const doc = await loadSpec();
    const ids: string[] = [];
    for (const [specPath, methods] of Object.entries(doc.paths ?? {})) {
      for (const op of Object.values(methods)) {
        expect(op.operationId).toBeTruthy();
        ids.push(op.operationId!);
        for (const match of specPath.matchAll(/\{([^}]+)\}/g)) {
          const declared = (op.parameters ?? []).some((param) => param.name === match[1] && param.in === 'path' && param.required === true);
          expect(declared, `${specPath} must declare path parameter ${match[1]}`).toBe(true);
        }
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(116);
  });

  it('resolves every $ref', async () => {
    const doc = await loadSpec();
    const refs = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          if (key === '$ref' && typeof child === 'string') refs.add(child);
          else walk(child);
        }
      }
    };
    walk(doc);
    for (const ref of refs) {
      expect(ref.startsWith('#/components/schemas/')).toBe(true);
      const name = ref.replace('#/components/schemas/', '');
      expect(doc.components?.schemas?.[name], `unresolved $ref ${ref}`).toBeDefined();
    }
    expect(refs.size).toBeGreaterThan(0);
  });
});
