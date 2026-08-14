export type AdminRole='viewer'|'operator'|'admin'|'developer';
export type AdminPermission='status.read'|'metrics.read'|'models.read'|'admin.actions.read'|'audit.read'|'characters.read'|'characters.write'|'world.read'|'world.write'|'world.confirm'|'device.read'|'device.write'|'memory.read'|'memory.write'|'plugin.reload'|'config.publish'|'code.write'|'users.read'|'users.create'|'users.update'|'users.disable'|'users.role.assign'|'users.credentials.rotate'|'sessions.read'|'sessions.revoke';
const READ:AdminPermission[]=['status.read','metrics.read','models.read','characters.read','world.read','device.read'];
const OPERATOR:AdminPermission[]=[...READ,'memory.read','characters.write','world.write','device.write'];
const ADMIN:AdminPermission[]=[...OPERATOR,'admin.actions.read','audit.read','memory.write','world.confirm','plugin.reload','config.publish','users.read','users.create','users.update','users.disable','users.role.assign','users.credentials.rotate','sessions.read','sessions.revoke'];
const GRANTS:Record<AdminRole,ReadonlySet<AdminPermission>>={viewer:new Set(READ),operator:new Set(OPERATOR),admin:new Set(ADMIN),developer:new Set([...ADMIN,'code.write'])};
export interface AdminPrincipal{id:string;role:AdminRole;enabled:boolean;}
export function permissionsFor(role:AdminRole):AdminPermission[]{return[...GRANTS[role]];}
export function can(principal:AdminPrincipal|undefined,permission:AdminPermission):boolean{return Boolean(principal?.enabled&&GRANTS[principal.role].has(permission));}
export function requirePermission(principal:AdminPrincipal|undefined,permission:AdminPermission):void{if(!can(principal,permission))throw new Error('forbidden');}
