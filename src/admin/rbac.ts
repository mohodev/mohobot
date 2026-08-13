export type AdminRole='viewer'|'operator'|'admin'|'developer';
export type AdminPermission='status.read'|'models.read'|'memory.read'|'world.write'|'plugin.reload'|'config.publish'|'code.write';
const GRANTS:Record<AdminRole,ReadonlySet<AdminPermission>>={viewer:new Set(['status.read','models.read']),operator:new Set(['status.read','models.read','memory.read','world.write']),admin:new Set(['status.read','models.read','memory.read','world.write','plugin.reload','config.publish']),developer:new Set(['status.read','models.read','memory.read','world.write','plugin.reload','config.publish','code.write'])};
export interface AdminPrincipal{id:string;role:AdminRole;enabled:boolean;}
export function can(principal:AdminPrincipal|undefined,permission:AdminPermission):boolean{return Boolean(principal?.enabled&&GRANTS[principal.role].has(permission));}
export function requirePermission(principal:AdminPrincipal|undefined,permission:AdminPermission):void{if(!can(principal,permission))throw new Error('forbidden');}
