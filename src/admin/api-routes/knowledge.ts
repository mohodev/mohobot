import type { ApiResult } from '../api-types.js';
import type { AdminApiRouteContext, AdminApiRouteRequest } from '../api-router.js';
import { HttpError } from '../api-errors.js';
import { intParam } from './helpers.js';

export async function handleKnowledgeRoutes(ctx: AdminApiRouteContext, route: AdminApiRouteRequest): Promise<ApiResult | undefined> {
  const { method, pathname, url, input, auth } = route;
    if(method==='GET'&&pathname==='/api/knowledge-bases')return ctx.ok({bases:await ctx.deps.knowledge.list(intParam(url,'offset')??0,intParam(url,'limit')??50)});
    if(method==='POST'&&pathname==='/api/knowledge-bases')return{status:201,body:{ok:true,base:await ctx.deps.knowledge.create({id:typeof input.id==='string'?input.id:undefined,name:String(input.name??''),description:typeof input.description==='string'?input.description:undefined})}};
    const kb=pathname.match(/^\/api\/knowledge-bases\/([^/]+)$/);if(kb){const baseId=decodeURIComponent(kb[1]!);if(method==='GET'){const base=await ctx.deps.knowledge.get(baseId);if(!base)throw new HttpError(404,'knowledge base not found');return ctx.ok({base});}if(method==='DELETE'){if(!await ctx.deps.knowledge.delete(baseId))throw new HttpError(404,'knowledge base not found');return ctx.ok({deleted:true});}}
    const docList=pathname.match(/^\/api\/knowledge-bases\/([^/]+)\/documents$/);if(docList){const baseId=decodeURIComponent(docList[1]!);if(method==='GET')return ctx.ok({documents:await ctx.deps.knowledge.listDocuments(baseId,intParam(url,'offset')??0,intParam(url,'limit')??50)});if(method==='POST')return ctx.ok({document:await ctx.deps.knowledge.upsertDocument({baseId,id:typeof input.id==='string'?input.id:undefined,name:String(input.name??''),text:String(input.text??'')})});}
    const doc=pathname.match(/^\/api\/knowledge-bases\/([^/]+)\/documents\/([^/]+)$/);if(doc){const baseId=decodeURIComponent(doc[1]!),id=decodeURIComponent(doc[2]!);if(method==='GET'){const document=await ctx.deps.knowledge.getDocument(baseId,id);if(!document)throw new HttpError(404,'document not found');return ctx.ok({document});}if(method==='DELETE'){if(!await ctx.deps.knowledge.deleteDocument(baseId,id))throw new HttpError(404,'document not found');return ctx.ok({deleted:true});}}
    const search=pathname.match(/^\/api\/knowledge-bases\/([^/]+)\/search$/);if(method==='GET'&&search)return ctx.ok({results:await ctx.deps.knowledge.search({baseId:decodeURIComponent(search[1]!),query:String(url.searchParams.get('q')??''),offset:intParam(url,'offset'),limit:intParam(url,'limit')})});
    const bindings=pathname.match(/^\/api\/knowledge-bases\/([^/]+)\/bindings$/);if(bindings){const baseId=decodeURIComponent(bindings[1]!);if(method==='GET')return ctx.ok({bindings:await ctx.deps.knowledge.bindings(baseId)});if(method==='POST')return ctx.ok({binding:await ctx.deps.knowledge.bind({baseId,targetType:input.targetType as 'bot'|'character',targetId:String(input.targetId??'')})});}
    const binding=pathname.match(/^\/api\/knowledge-bases\/([^/]+)\/bindings\/([^/]+)\/([^/]+)$/);if(method==='DELETE'&&binding){if(!await ctx.deps.knowledge.unbind(decodeURIComponent(binding[1]!),decodeURIComponent(binding[2]!) as 'bot'|'character',decodeURIComponent(binding[3]!)))throw new HttpError(404,'binding not found');return ctx.ok({deleted:true});}

  return undefined;
}
