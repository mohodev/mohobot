import type { ApiResult } from '../api-types.js';
import type { AdminApiRouteContext, AdminApiRouteRequest } from '../api-router.js';
import { HttpError } from '../api-errors.js';
import { defaultPolicy as mcpDefaultPolicy } from '../../mcp/permissions.js';
import { importCharacters, type CharacterImportItem } from '../../characters/import.js';

export async function handleCharacterMcpRoutes(ctx: AdminApiRouteContext, route: AdminApiRouteRequest): Promise<ApiResult | undefined> {
  const { method, pathname, url, input, auth } = route;
    if (method === 'GET' && pathname === '/api/characters') {
      const rows = await ctx.deps.characters.list();
      return ctx.ok({ characters: rows.map(({ prompt, ...item }) => ({ ...item, promptLength: prompt.length })) });
    }
    const characterMatch=pathname.match(/^\/api\/characters\/([^/]+)$/);
    if(method==='GET'&&characterMatch){const character=await ctx.deps.characters.get(decodeURIComponent(characterMatch[1]!));if(!character)throw new HttpError(404,'character not found');return ctx.ok({character});}
    if(method==='PUT'&&characterMatch){const id=decodeURIComponent(characterMatch[1]!);const expectedRevision=String(input.expectedRevision??'');if(!/^[a-f0-9]{64}$/.test(expectedRevision))throw new HttpError(400,'expectedRevision required');const saved=await ctx.deps.characters.save({id,name:String(input.name??'').trim(),prompt:String(input.prompt??''),source:typeof input.source==='string'?input.source:undefined,expectedRevision});return ctx.ok({character:saved});}
    if (method === 'POST' && pathname === '/api/characters') {
      const saved = await ctx.deps.characters.save({ id: typeof input.id === 'string' ? input.id : undefined, name: String(input.name ?? '').trim(), prompt: String(input.prompt ?? ''), source: typeof input.source === 'string' ? input.source : undefined });
      return { status: 201, body: { ok: true, character: { ...saved, promptLength: saved.prompt.length } } };
    }
    if (method === 'POST' && pathname === '/api/characters/import') {
      const rawItems = input.items;
      if (!Array.isArray(rawItems)) throw new HttpError(400, 'items must be an array');
      const items: CharacterImportItem[] = rawItems.map((it) => {
        const o = (it ?? {}) as Record<string, unknown>;
        return {
          id: typeof o.id === 'string' ? o.id : undefined,
          name: String(o.name ?? '').trim(),
          prompt: String(o.prompt ?? ''),
          source: typeof o.source === 'string' ? o.source : undefined,
          expectedRevision: typeof o.expectedRevision === 'string' ? o.expectedRevision : undefined,
        };
      });
      const dryRun = input.dryRun === true;
      const onConflict = input.onConflict === 'overwrite' ? 'overwrite' : 'skip';
      const report = await importCharacters(ctx.deps.characters, items, { dryRun, onConflict });
      return ctx.ok({ report });
    }
    if (method === 'POST' && pathname === '/api/characters/cross-chat') {
      if (!ctx.deps.opts.crossChat) throw new HttpError(409, 'cross-chat unavailable');
      const characterIds = input.characterIds;
      if (!Array.isArray(characterIds) || characterIds.length < 2) throw new HttpError(400, 'characterIds requires >= 2 entries');
      const topic = String(input.topic ?? '').trim();
      if (!topic) throw new HttpError(400, 'topic required');
      const result = await ctx.deps.opts.crossChat({
        characterIds: characterIds.map((x) => String(x)),
        topic,
        startWith: typeof input.startWith === 'string' ? input.startWith : undefined,
        botId: typeof input.botId === 'string' ? input.botId : undefined,
      });
      return ctx.ok({ result });
    }
    if (method === 'GET' && pathname === '/api/mcp/policy') {
      return ctx.ok({ rules: mcpDefaultPolicy.rules });
    }
    if (method === 'GET' && pathname === '/api/mcp/tools') {
      if (!ctx.deps.opts.mcp) throw new HttpError(409, 'mcp unavailable');
      return ctx.ok({ servers: ctx.deps.opts.mcp.status(), tools: ctx.deps.opts.mcp.tools() });
    }
    if (method === 'GET' && pathname === '/api/mcp/audit') {
      if (!ctx.deps.opts.mcp) throw new HttpError(409, 'mcp unavailable');
      return ctx.ok({ entries: ctx.deps.opts.mcp.audit() });
    }
    if (method === 'POST' && pathname === '/api/mcp/call') {
      if (!ctx.deps.opts.mcp) throw new HttpError(409, 'mcp unavailable');
      const server = typeof input.server === 'string' ? input.server : '';
      const tool = typeof input.tool === 'string' ? input.tool.trim() : '';
      if (!server || !tool) throw new HttpError(400, 'server and tool required');
      const rawArgs = input.arguments;
      if (rawArgs !== undefined && (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs))) {
        throw new HttpError(400, 'arguments must be an object');
      }
      const result = await ctx.deps.opts.mcp.callTool(server, tool, rawArgs as Record<string, unknown> | undefined, {
        id: auth.principal.id,
        role: auth.principal.role,
      });
      return ctx.ok({ result });
    }

  return undefined;
}
