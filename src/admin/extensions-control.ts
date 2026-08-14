import type { Registries } from '../core/registries.js';
export interface ExtensionEntry{name:string;source:string;description?:string;needsKey:boolean;}
export interface ExtensionsControl{list():Record<'providers'|'gateways'|'storages'|'memories',ExtensionEntry[]>;}
function project(registry:{list():Array<{name:string;source:string;description?:string;needsKey?:unknown}>}):ExtensionEntry[]{return registry.list().map(x=>({name:x.name,source:x.source, ...(x.description?{description:x.description}:{}),needsKey:typeof x.needsKey==='function'||Boolean(x.needsKey)}));}
export class ExtensionsControlFacade implements ExtensionsControl{readonly #registries:Registries;constructor(registries:Registries){this.#registries=registries;}list(){return{providers:project(this.#registries.providers),gateways:project(this.#registries.gateways),storages:project(this.#registries.storages),memories:project(this.#registries.memories)};}}
