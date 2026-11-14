import type { ApiResult } from '../api-types.js';
import type { AdminApiRouteContext, AdminApiRouteRequest } from '../api-router.js';
import { HttpError } from '../api-errors.js';
import { can, type AdminRole } from '../rbac.js';

export async function handleConfigUserRoutes(ctx: AdminApiRouteContext, route: AdminApiRouteRequest): Promise<ApiResult | undefined> {
  const { method, pathname, url, input, auth } = route;
    if (method === 'GET' && pathname === '/api/config/publication') return ctx.ok({ publication: await ctx.deps.opts.configPublication?.get() ?? null });
    if (method === 'POST' && pathname === '/api/config/publish') {
      if (!ctx.deps.opts.configPublication) throw new HttpError(409, 'config publication unavailable');
      return ctx.ok({ publication: await ctx.deps.opts.configPublication.publish(input, auth.principal) });
    }
    if(method==='POST'&&pathname==='/api/config/ack'){if(!ctx.deps.opts.configPublication?.acknowledge)throw new HttpError(409,'config acknowledgement unavailable');return ctx.ok({publication:await ctx.deps.opts.configPublication.acknowledge(input,auth.principal)});}
    if(method==='POST'&&pathname==='/api/config/rollback'){if(!ctx.deps.opts.configPublication?.rollback)throw new HttpError(409,'config rollback unavailable');return ctx.ok({publication:await ctx.deps.opts.configPublication.rollback(input,auth.principal)});}
    if(method==='GET'&&pathname==='/api/config/activation-receipts'){if(!ctx.deps.opts.configPublication?.activationReceipts)throw new HttpError(409,'config activation receipts unavailable');const scope=url.searchParams.get('scope');return ctx.ok({receipts:await ctx.deps.opts.configPublication.activationReceipts(scope===null||scope.trim()===''?undefined:scope)});}
    if(method==='POST'&&pathname==='/api/config/activation-receipt'){if(!ctx.deps.opts.configPublication?.recordActivation)throw new HttpError(409,'config activation receipt unavailable');return ctx.ok({receipt:await ctx.deps.opts.configPublication.recordActivation(input,auth.principal)});}
    if (method === 'GET' && pathname === '/api/admin/users') return ctx.ok({ users: await ctx.deps.auth.listUsers() });
    if (method === 'POST' && pathname === '/api/admin/users') {
      const role = ctx.assignableRole(auth.principal, input.role);
      if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new HttpError(400, 'enabled must be boolean');
      const user = await ctx.deps.auth.createUser({ username: String(input.username ?? ''), password: String(input.password ?? ''), role, enabled: input.enabled === undefined ? true : input.enabled });
      return { status: 201, body: { ok: true, user } };
    }
    const userMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
    if (method === 'PATCH' && userMatch) {
      const identifier = decodeURIComponent(userMatch[1]!);
      const target=await ctx.deps.auth.resolveUserIdentifier(identifier);if(!target)throw new HttpError(404,'user not found');
      const username=target.normalizedUsername;
      const patch: { username?: string; role?: AdminRole; enabled?: boolean } = {};
      if (input.username !== undefined) patch.username = String(input.username);
      if (input.role !== undefined) {
        if (!can(auth.principal, 'users.role.assign')) throw new HttpError(403, 'forbidden');
        patch.role = ctx.assignableRole(auth.principal, input.role);
      }
      if (input.enabled !== undefined) {
        if (!can(auth.principal, 'users.disable')) throw new HttpError(403, 'forbidden');
        if (typeof input.enabled !== 'boolean') throw new HttpError(400, 'enabled must be boolean');
        patch.enabled = input.enabled;
      }
      return ctx.ok({ user: await ctx.deps.auth.updateUser(username, patch) });
    }
    const passwordMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/password$/);
    if (method === 'POST' && passwordMatch) {
      const identifier=decodeURIComponent(passwordMatch[1]!);const target=await ctx.deps.auth.resolveUserIdentifier(identifier);if(!target)throw new HttpError(404,'user not found');
      await ctx.deps.auth.changePassword(target.normalizedUsername, String(input.password ?? ''));
      return ctx.ok({ changed: true });
    }

  return undefined;
}
